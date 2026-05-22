"""Seed Averaging 单测（M4 Part L）。

mock 注入 train_fn，避免连库 / 走真实训练；只验证：
  - 父 ml.model_runs 写入参数（mock _write_ensemble_model_run）
  - 5 seed → 5 child_run_ids
  - model_version 命名规范 `lgb-lambdarank-v1-<YYYYMMDD>-seedavg5`
  - 集成 oos_metrics 对 5 seed 求平均
"""

from __future__ import annotations

from typing import Any
from uuid import uuid4

import pytest

from quant_pipeline.training import seed_averaging


class _FakeResult:
    def __init__(self, run_id: Any, model_version: str, oos: dict[str, Any]) -> None:
        self.model_run_id = run_id
        self.model_version = model_version
        self.artifact_uri = f"./artifacts/{run_id}/model.txt"
        self.oos_metrics = oos


@pytest.fixture(autouse=True)
def _patch_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(seed_averaging, "update_progress", lambda *a, **k: None)


def test_train_seed_average_runs_five_seeds_and_writes_parent(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))

    call_seeds: list[int] = []

    def _fake_train(*, feature_set_id, model, walk_forward, seed, job_id, with_shap=True):
        call_seeds.append(seed)
        assert with_shap is False, "子 seed 训练必须 with_shap=False（评审 04-#11）"
        return _FakeResult(
            uuid4(),
            f"lgb-lambdarank-v1-20260517-seed{seed}",
            {"ic": 0.05 + seed * 1e-6, "ndcg@10": 0.4 + seed * 1e-6},
        )

    written_runs: list[dict[str, Any]] = []

    def _fake_write(*args, **kwargs):
        written_runs.append(kwargs)
        return uuid4(), "./artifacts/x/seed_avg_meta.json"

    monkeypatch.setattr(seed_averaging, "_write_ensemble_model_run", _fake_write)

    out = seed_averaging.train_seed_average(
        feature_set_id="fs_v1",
        seeds=[42, 123, 456, 789, 1024],
        parent_job_id=None,  # 无 parent → 不创建 child ml.jobs（避免连库）
        train_fn=_fake_train,
        today_yyyymmdd="20260517",
    )

    assert call_seeds == [42, 123, 456, 789, 1024]
    assert out["ensemble_model_version"] == "lgb-lambdarank-v1-20260517-seedavg5"
    assert len(out["child_model_run_ids"]) == 5
    assert len(out["child_model_versions"]) == 5
    # 集成 oos 平均
    assert out["ensemble_oos_metrics"]["n_seeds"] == 5
    assert out["ensemble_oos_metrics"]["ic"] == pytest.approx(
        sum(0.05 + s * 1e-6 for s in [42, 123, 456, 789, 1024]) / 5
    )
    assert len(written_runs) == 1
    assert written_runs[0]["ensemble_model_version"] == out["ensemble_model_version"]


def test_train_seed_average_rejects_empty_seeds() -> None:
    with pytest.raises(ValueError, match="seeds"):
        seed_averaging.train_seed_average(
            feature_set_id="fs_v1",
            seeds=[],
            train_fn=lambda **k: None,
        )


def test_train_seed_average_propagates_child_failure(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    """子 seed 训练失败 → 整体抛出 + 不再继续后续 seed。"""

    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))
    monkeypatch.setattr(
        seed_averaging,
        "_write_ensemble_model_run",
        lambda **k: (uuid4(), "./artifacts/x/seed_avg_meta.json"),
    )

    call_seeds: list[int] = []

    def _flaky_train(*, feature_set_id, model, walk_forward, seed, job_id, with_shap=True):
        call_seeds.append(seed)
        if seed == 456:
            raise RuntimeError("training failed")
        return _FakeResult(uuid4(), f"mv-{seed}", {"ic": 0.0})

    with pytest.raises(RuntimeError, match="training failed"):
        seed_averaging.train_seed_average(
            feature_set_id="fs_v1",
            seeds=[42, 123, 456, 789, 1024],
            train_fn=_flaky_train,
            today_yyyymmdd="20260517",
        )
    # 在 456 出错后即停，不再跑 789/1024
    assert call_seeds == [42, 123, 456]


def test_average_metrics_handles_missing_keys() -> None:
    m1 = {"ic": 0.1, "ndcg@10": 0.4, "walk_forward": True}
    m2 = {"ic": 0.2, "ndcg@10": 0.5}
    m3 = {"ic": 0.3}
    agg = seed_averaging._average_metrics([m1, m2, m3])
    assert agg["ic"] == pytest.approx(0.2)
    assert agg["ndcg@10"] == pytest.approx(0.45)
    assert agg["walk_forward"] is True
    assert agg["n_seeds"] == 3


def test_dispatcher_route_seed_avg_present() -> None:
    from quant_pipeline.worker.dispatcher import get_routes

    routes = get_routes()
    assert "seed_avg" in routes
    assert routes["seed_avg"].__name__ != "_runner_not_implemented"
    assert routes["seed_avg"].__name__ == "_runner_seed_avg"


def test_runner_entrypoint_validates_params() -> None:
    class _BadJob:
        id = None
        params = {"seeds": [42]}

    with pytest.raises(ValueError, match="feature_set_id"):
        seed_averaging.runner_entrypoint(_BadJob())

    class _BadJob2:
        id = None
        params = {"feature_set_id": "fs", "seeds": "not-a-list"}

    with pytest.raises(ValueError, match="seeds"):
        seed_averaging.runner_entrypoint(_BadJob2())
