"""evaluation.shap_explainer（M4 Part A · SHAP）单测。

不连库；用真实 LightGBM Booster + 注入 mock loaders。

验证：
  1. compute_shap / explain 返回 top-K JSON 落盘到 ./artifacts/<run_id>/shap_top20.json
  2. JSON schema 含必填字段：model_run_id, model_version, top20[{factor_id, mean_abs_shap, ...}]
  3. mean_abs_shap 降序排列且长度 ≤ top_k
  4. safely_explain_after_train 在底层 explain 抛错时不外抛，并写 quality_reports
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
import pandas as pd
import pytest


def _train_small_booster(n_features: int = 5, n_samples: int = 300) -> Any:
    """训一棵很小的 LightGBM Booster（不依赖 LambdaRank，回归足够测试 SHAP）。"""

    import lightgbm as lgb

    rng = np.random.default_rng(42)
    X = rng.normal(0.0, 1.0, size=(n_samples, n_features))
    # 让 feat0 最重要、feat1 次之
    y = 2.0 * X[:, 0] + 1.0 * X[:, 1] + 0.1 * rng.normal(size=n_samples)
    dataset = lgb.Dataset(X, label=y)
    booster = lgb.train(
        {
            "objective": "regression",
            "metric": "rmse",
            "num_leaves": 7,
            "learning_rate": 0.1,
            "verbose": -1,
        },
        dataset,
        num_boost_round=30,
    )
    return booster


@pytest.fixture
def small_booster() -> Any:
    return _train_small_booster()


@pytest.fixture
def feature_columns() -> list[str]:
    return ["f0", "f1", "f2", "f3", "f4"]


def test_explain_writes_shap_top20_json(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    small_booster: Any,
    feature_columns: list[str],
) -> None:
    """完整路径：注入 booster_loader + meta_loader + load_sample_features → 落盘 JSON。"""

    # ARTIFACT_DIR 改到 tmp，便于校验落盘
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))

    from quant_pipeline.evaluation import shap_explainer as mod
    from quant_pipeline.utils import paths as paths_mod

    # 让 utils.paths 重新解析 ARTIFACT_DIR
    (
        paths_mod.artifact_root.cache_clear()
        if hasattr(paths_mod.artifact_root, "cache_clear")
        else None
    )

    run_id = str(uuid4())
    artifact_uri = f"./artifacts/{run_id}/model.txt"

    # 模拟 ml.model_runs 行
    def _fake_load_model_run(rid: str) -> dict[str, Any]:
        return {
            "id": rid,
            "model_version": "lgb-test-v1",
            "feature_set_id": "fs_test",
            "artifact_uri": artifact_uri,
        }

    # mock sample features：300 行随机
    def _fake_features(fs: str, cols: list[str], n: int) -> pd.DataFrame:
        rng = np.random.default_rng(7)
        data = rng.normal(0.0, 1.0, size=(n, len(cols)))
        return pd.DataFrame(data, columns=cols)

    shap_uri = mod.explain(
        run_id,
        n_samples=200,
        top_k=3,
        load_model_run=_fake_load_model_run,
        load_sample_features=_fake_features,
        booster_loader=lambda _uri: small_booster,
        meta_loader=lambda _uri: {"feature_columns_order": feature_columns},
        skip_db_write=True,
    )

    assert shap_uri.endswith("/shap_top20.json")
    # 找到落盘文件（路径在 artifact_root / <uuid> 下）
    # 由于上面构造的 artifact_uri 是 ./artifacts/<uuid>/model.txt
    # _resolve_artifact_local_path 会把它解析到 artifact_root() / <uuid> / model.txt
    # 而 ARTIFACT_DIR=tmp_path，所以最终 parent = tmp_path / <uuid>
    found = list(tmp_path.rglob("shap_top20.json"))
    assert len(found) == 1, f"未找到 shap_top20.json，找到 {found}"
    payload = json.loads(found[0].read_text(encoding="utf-8"))

    # schema 校验
    assert payload["model_run_id"] == run_id
    assert payload["model_version"] == "lgb-test-v1"
    assert payload["top_k"] == 3
    assert isinstance(payload["top20"], list)
    assert len(payload["top20"]) <= 3
    for entry in payload["top20"]:
        assert {"factor_id", "mean_abs_shap", "mean_shap", "direction"} <= entry.keys()
        assert entry["direction"] in ("+", "-")

    # 降序
    vals = [e["mean_abs_shap"] for e in payload["top20"]]
    assert vals == sorted(vals, reverse=True)
    # feat0 / feat1 应排在前列（我们构造 y = 2*f0 + 1*f1）
    top_names = [e["factor_id"] for e in payload["top20"]]
    assert "f0" in top_names


def test_safely_explain_after_train_swallows_errors(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """explain 抛错 → safely_explain_after_train 返回 None 且写 quality_reports."""

    from quant_pipeline.evaluation import shap_explainer as mod

    def _bad_explain(*a: Any, **k: Any) -> str:
        raise RuntimeError("simulated shap failure")

    monkeypatch.setattr(mod, "explain", _bad_explain)

    warn_calls: list[dict[str, Any]] = []

    def _fake_warn(**kwargs: Any) -> None:
        warn_calls.append(kwargs)

    # warn_with_quality_report 是延迟 import 的 —— patch 它的源
    from quant_pipeline.worker import progress as progress_mod

    monkeypatch.setattr(progress_mod, "warn_with_quality_report", _fake_warn)

    result = mod.safely_explain_after_train(
        uuid4(), trade_date="20260517", job_id=uuid4()
    )
    assert result is None
    assert len(warn_calls) == 1
    assert warn_calls[0]["rule"] == "shap_explainer_failed"
    assert warn_calls[0]["level"] == "warn"
    assert "model_run_id" in warn_calls[0]["detail"]
