"""SHAP 解释器单测（M4 Part L）。

不连库；用 monkeypatch + 真实 LightGBM Booster：
  - 训一个小 booster
  - 注入 load_model_run / load_sample_features / meta_loader
  - 验证 shap_top20.json 落盘 + Top-K 排序 / direction 字段
"""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any
from uuid import uuid4

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.evaluation import shap_explainer


def _train_small_booster() -> Any:
    """训一个 30 样本的小 LightGBM regression booster（feat_a 有强信号）。"""

    import lightgbm as lgb

    rng = np.random.default_rng(0)
    n = 200
    feat_a = rng.normal(size=n)
    feat_b = rng.normal(size=n)
    feat_c = rng.normal(size=n)
    y = 2.0 * feat_a + 0.1 * feat_b + 0.0 * feat_c + rng.normal(0, 0.1, size=n)
    X = np.stack([feat_a, feat_b, feat_c], axis=1)
    ds = lgb.Dataset(X, label=y, feature_name=["feat_a", "feat_b", "feat_c"])
    params = {"objective": "regression", "verbose": -1, "min_data_in_leaf": 5}
    return lgb.train(params, ds, num_boost_round=20)


def test_explain_writes_top20_json_with_direction(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))

    run_id = str(uuid4())
    # 写一个 fake artifact 目录（注意 ARTIFACT_DIR/run_id/model.txt）
    artifact_uri_str = f"./artifacts/{run_id}/model.txt"
    run_dir = Path(tmp_path) / run_id
    run_dir.mkdir(parents=True, exist_ok=True)
    booster = _train_small_booster()
    booster.save_model(str(run_dir / "model.txt"))
    (run_dir / "meta.json").write_text(
        json.dumps({"feature_columns_order": ["feat_a", "feat_b", "feat_c"]}),
        encoding="utf-8",
    )

    # mock 加载 model_run + 抽样
    monkeypatch.setattr(
        shap_explainer,
        "_load_model_run_row",
        lambda rid: {
            "id": rid,
            "model_version": "lgb-mock-v1",
            "feature_set_id": "fs_mock",
            "artifact_uri": artifact_uri_str,
        },
    )
    rng = np.random.default_rng(1)
    sample_df = pd.DataFrame(
        {
            "feat_a": rng.normal(size=50),
            "feat_b": rng.normal(size=50),
            "feat_c": rng.normal(size=50),
        }
    )
    monkeypatch.setattr(
        shap_explainer,
        "_load_sample_features",
        lambda fs, cols, n: sample_df[cols],
    )
    # 跳过 DB 写
    shap_uri = shap_explainer.explain(run_id, n_samples=50, top_k=3, skip_db_write=True)

    assert shap_uri.endswith("/shap_top20.json")
    out_path = run_dir / "shap_top20.json"
    assert out_path.exists()
    payload = json.loads(out_path.read_text(encoding="utf-8"))
    assert payload["model_run_id"] == run_id
    assert payload["n_samples"] == 50
    top = payload["top20"]
    assert len(top) == 3
    # feat_a 在合成数据中是主驱动，应排第 1
    assert top[0]["factor_id"] == "feat_a"
    assert top[0]["mean_abs_shap"] > top[1]["mean_abs_shap"]
    assert top[0]["direction"] in ("+", "-")


def test_explain_rejects_missing_artifact(
    monkeypatch: pytest.MonkeyPatch, tmp_path: Any
) -> None:
    monkeypatch.setenv("ARTIFACT_DIR", str(tmp_path))
    monkeypatch.setattr(
        shap_explainer,
        "_load_model_run_row",
        lambda rid: {
            "id": rid,
            "model_version": "mv",
            "feature_set_id": "fs",
            "artifact_uri": "./artifacts/no_such_uuid/model.txt",
        },
    )
    with pytest.raises(FileNotFoundError, match="artifact 不存在"):
        shap_explainer.explain("no_such_uuid", skip_db_write=True)


def test_safely_explain_after_train_logs_warn_on_failure(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """SHAP 失败时不抛，写一条 quality_reports(rule='shap_explainer_failed')。"""

    def _boom(rid: str, **kwargs: Any) -> str:
        raise RuntimeError("oops")

    monkeypatch.setattr(shap_explainer, "explain", _boom)

    quality_writes: list[dict[str, Any]] = []

    def _capture_warn(*, rule, trade_date, detail, level, job_id):
        quality_writes.append(
            {"rule": rule, "trade_date": trade_date, "detail": detail, "level": level}
        )

    import quant_pipeline.worker.progress as wp

    monkeypatch.setattr(wp, "warn_with_quality_report", _capture_warn)

    out = shap_explainer.safely_explain_after_train(
        "abc-run-id", trade_date="20260517"
    )
    assert out is None
    assert len(quality_writes) == 1
    assert quality_writes[0]["rule"] == "shap_explainer_failed"
    assert quality_writes[0]["level"] == "warn"
    assert quality_writes[0]["trade_date"] == "20260517"


def test_resolve_artifact_local_path_handles_posix_relative() -> None:
    """`./artifacts/<uuid>/model.txt` → ARTIFACT_DIR/<uuid>/model.txt"""

    from quant_pipeline.utils.paths import artifact_root

    out = shap_explainer._resolve_artifact_local_path("./artifacts/abc/model.txt")
    assert out == artifact_root() / "abc" / "model.txt"


def test_shap_explainer_failed_rule_in_allowed() -> None:
    """ALLOWED_RULES 必须含 shap_explainer_failed（spec 硬约束）。"""

    from quant_pipeline.quality.report import ALLOWED_RULES

    assert "shap_explainer_failed" in ALLOWED_RULES
