"""training.runner 单测（M2 Part G）。

不连库；用 monkeypatch 替换：
  - quality.runner.run_checks（通过 / 抛 QualityGateBlocked）
  - training.runner._load_feature_matrix（小样本 mock DataFrame）
  - training.runner._insert_model_run（捕获入参，验证 SQL 参数）
  - training.runner.update_progress（no-op）
  - training.runner._write_artifact（捕获 booster + meta，模拟落盘）
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.quality.runner import QualityGateBlocked
from quant_pipeline.training import runner as runner_mod


def _mock_feature_matrix(n_dates: int = 25, n_codes: int = 10) -> pd.DataFrame:
    """生成 mock feature_matrix 形态：trade_date / ts_code / features:dict / label:float。"""

    rng = np.random.default_rng(42)
    records: list[dict[str, Any]] = []
    for d in range(n_dates):
        td = f"2026{(1 + d // 28):02d}{(1 + d % 28):02d}"
        # 真信号 + 噪声
        true_signal = rng.normal(0.0, 1.0, size=n_codes)
        for i in range(n_codes):
            features = {
                "feat0": float(true_signal[i] + rng.normal(0.0, 0.3)),
                "feat1": float(rng.normal()),
                "feat2": float(rng.normal()),
            }
            label = float(rng.integers(0, n_codes))  # 0..9 排名标签
            records.append(
                {
                    "trade_date": td,
                    "ts_code": f"00000{i}.SZ",
                    "features": features,
                    "label": label,
                }
            )
    return pd.DataFrame(records)


@pytest.fixture(autouse=True)
def _patch_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    """避免 update_progress 触发 session_scope 连库。"""

    monkeypatch.setattr(runner_mod, "update_progress", lambda *a, **k: None)


def test_train_model_quality_blocked_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """quality gate 失败 → 抛 QualityGateBlocked + 不会写 ml.model_runs / 不落盘。"""

    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fs: _mock_feature_matrix())

    def _fake_gate(trade_date: str, *, mode: str, strict: bool, job_id: Any) -> None:
        raise QualityGateBlocked(rule="row_count_drift", detail={"date": trade_date})

    monkeypatch.setattr(runner_mod, "gate_check", _fake_gate)

    inserted: list[dict[str, Any]] = []
    monkeypatch.setattr(
        runner_mod,
        "_insert_model_run",
        lambda *a, **k: inserted.append(dict(k)),
    )

    written: list[tuple[UUID, Any, dict[str, Any]]] = []

    def _fake_write_artifact(run_id: Any, booster: Any, meta: dict[str, Any]) -> tuple[str, str]:
        written.append((run_id, booster, meta))
        return ("./artifacts/x/model.txt", "./artifacts/x/meta.json")

    monkeypatch.setattr(runner_mod, "_write_artifact", _fake_write_artifact)

    with pytest.raises(QualityGateBlocked) as exc_info:
        runner_mod.train_model("fs_v1", seed=42)
    assert exc_info.value.rule == "row_count_drift"
    assert inserted == []
    assert written == []


def test_train_model_quality_passed_full_path(monkeypatch: pytest.MonkeyPatch) -> None:
    """quality 通过 → 训练完成 → 写 ml.model_runs，artifact 调用 once。"""

    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fs: _mock_feature_matrix())
    monkeypatch.setattr(
        runner_mod,
        "gate_check",
        lambda trade_date, *, mode, strict, job_id: None,
    )

    inserted: list[dict[str, Any]] = []

    def _fake_insert(run_id: Any, **kwargs: Any) -> None:
        inserted.append({"run_id": run_id, **kwargs})

    monkeypatch.setattr(runner_mod, "_insert_model_run", _fake_insert)

    written: list[tuple[Any, Any, dict[str, Any]]] = []

    def _fake_write_artifact(run_id: Any, booster: Any, meta: dict[str, Any]) -> tuple[str, str]:
        written.append((run_id, booster, meta))
        return (
            f"./artifacts/{run_id}/model.txt",
            f"./artifacts/{run_id}/meta.json",
        )

    monkeypatch.setattr(runner_mod, "_write_artifact", _fake_write_artifact)

    # 让 LightGBM 跑得动 mock 小样本：覆盖默认 hyperparams
    # mock 数据只有 25 个交易日，不足 PurgedWalkForwardSplit 所需，使用单 fold 通路
    result = runner_mod.train_model(
        "fs_v1",
        seed=42,
        walk_forward=False,
        hyperparams={"min_data_in_leaf": 3, "num_leaves": 7},
    )

    assert len(inserted) == 1
    assert inserted[0]["model_version"].startswith("lgb-lambdarank-v1-")
    assert inserted[0]["model_version"].endswith("-seed42")
    assert inserted[0]["feature_set_id"] == "fs_v1"
    assert "oos_metrics" in inserted[0]
    assert "ndcg@10" in inserted[0]["oos_metrics"]

    assert len(written) == 1
    assert result.model_version.startswith("lgb-lambdarank-v1-")
    assert result.artifact_uri.startswith("./artifacts/")
    assert result.artifact_uri.endswith("/model.txt")


def test_train_model_rejects_unknown_model(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fs: _mock_feature_matrix())
    with pytest.raises(ValueError, match="lgb-lambdarank"):
        runner_mod.train_model("fs_v1", model="xgboost")


def test_train_model_insert_failure_rolls_back_artifact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """ml.model_runs 写库失败时，artifact 目录被清理（任一失败回滚另一个）。"""

    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))
    # 重置 artifact_root 的 lru_cache（这里它没缓存，直接读 env，OK）

    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fs: _mock_feature_matrix())
    monkeypatch.setattr(
        runner_mod,
        "gate_check",
        lambda trade_date, *, mode, strict, job_id: None,
    )

    # 真实落盘（用 tmp_path），让 rmtree 清理可观察
    def _fail_insert(*a: Any, **k: Any) -> None:
        raise RuntimeError("db down")

    monkeypatch.setattr(runner_mod, "_insert_model_run", _fail_insert)

    with pytest.raises(RuntimeError, match="db down"):
        runner_mod.train_model(
            "fs_v1",
            seed=42,
            walk_forward=False,
            hyperparams={"min_data_in_leaf": 3, "num_leaves": 7},
        )

    # tmp_path 下不应残留任何 model_run_id 目录
    leftovers = [p for p in tmp_path.iterdir() if p.is_dir()]
    assert leftovers == [], f"artifact 目录未被回滚: {leftovers}"


def test_train_model_dispatcher_route_present() -> None:
    """dispatcher _ROUTES 必须含 train 且不是 _runner_not_implemented。"""

    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "train" in routes
    assert routes["train"].__name__ != "_runner_not_implemented"
    assert routes["train"].__name__ == "_runner_train"


def test_train_model_runner_entrypoint_validates_params() -> None:
    """runner_entrypoint 缺 feature_set_id 应 raise。"""

    class _MockJob:
        id = None
        params = {"model": "lgb-lambdarank"}

    with pytest.raises(ValueError, match="feature_set_id"):
        runner_mod.runner_entrypoint(_MockJob())
