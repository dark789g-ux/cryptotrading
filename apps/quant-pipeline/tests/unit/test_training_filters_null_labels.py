# -*- coding: utf-8 -*-
"""training.runner labels-optional 安全防御层契约测试。

spec 2026-05-29-inference-only-feature-matrix.md 的核心安全前提：
feature_matrix 可能含 ``label IS NULL`` 行（inference-only 写入），训练侧
runner.py:289 `valid_mask = y_all.notna()` 会显式过滤掉这些行。

本测试用 mock _load_feature_matrix 注入含 NaN label 的行，断言：
  1. 训练能跑通（不被 NaN 污染）
  2. 落库的 oos_metrics / model_version 仍按"有效样本"计算
"""

from __future__ import annotations

from typing import Any
from uuid import UUID

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training import runner as runner_mod


def _mock_feature_matrix_with_nan_labels(
    n_dates: int = 25,
    n_codes: int = 10,
    nan_ratio: float = 0.2,
) -> pd.DataFrame:
    """生成 mock feature_matrix；随机把 ``nan_ratio`` 比例的 label 改成 NaN
    （模拟 inference-only 写入的"未闭合"行）。"""

    rng = np.random.default_rng(42)
    records: list[dict[str, Any]] = []
    for d in range(n_dates):
        td = f"2026{(1 + d // 28):02d}{(1 + d % 28):02d}"
        true_signal = rng.normal(0.0, 1.0, size=n_codes)
        for i in range(n_codes):
            features = {
                "feat0": float(true_signal[i] + rng.normal(0.0, 0.3)),
                "feat1": float(rng.normal()),
                "feat2": float(rng.normal()),
            }
            label_val = float(rng.integers(0, n_codes))
            if rng.random() < nan_ratio:
                label_val = float("nan")
            records.append(
                {
                    "trade_date": td,
                    "ts_code": f"00000{i}.SZ",
                    "features": features,
                    "label": label_val,
                }
            )
    return pd.DataFrame(records)


@pytest.fixture(autouse=True)
def _patch_progress(monkeypatch: pytest.MonkeyPatch) -> None:
    monkeypatch.setattr(runner_mod, "update_progress", lambda *a, **k: None)


def test_training_filters_null_label_rows(monkeypatch: pytest.MonkeyPatch) -> None:
    """含 ~20% NaN label 的 feature_matrix 应被过滤后训练，model_run 元数据
    的 oos_metrics 仍能算出（非全 NaN 行足够）。"""

    df_with_nan = _mock_feature_matrix_with_nan_labels(nan_ratio=0.2)
    non_nan_count = int(df_with_nan["label"].notna().sum())
    assert non_nan_count >= 20, "测试夹具有效样本不足，请调 n_dates / n_codes"

    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fs, **_: df_with_nan)
    monkeypatch.setattr(
        runner_mod,
        "gate_check",
        lambda trade_date, *, mode, strict, job_id: None,
    )

    inserted: list[dict[str, Any]] = []
    monkeypatch.setattr(
        runner_mod,
        "_insert_model_run",
        lambda run_id, **kwargs: inserted.append({"run_id": run_id, **kwargs}),
    )

    written: list[tuple[Any, Any, dict[str, Any]]] = []

    def _fake_write_artifact(run_id: Any, booster: Any, meta: dict[str, Any]) -> tuple[str, str]:
        written.append((run_id, booster, meta))
        return (
            f"./artifacts/{run_id}/model.txt",
            f"./artifacts/{run_id}/meta.json",
        )

    monkeypatch.setattr(runner_mod, "_write_artifact", _fake_write_artifact)

    result = runner_mod.train_model(
        "fs_v1",
        seed=42,
        walk_forward=False,
        hyperparams={"min_data_in_leaf": 3, "num_leaves": 7},
    )

    assert len(inserted) == 1
    assert inserted[0]["model_version"].endswith("-seed42")
    assert "ndcg@10" in inserted[0]["oos_metrics"]
    # 写入的 artifact 来自有效样本（非 NaN）；NaN 行不影响产物
    assert result.artifact_uri.endswith("/model.txt")


def test_training_blocks_when_valid_samples_below_threshold(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    """若有效 label 行数 < 20，training 必须抛 ValueError；NaN 行不能凑数。"""

    rng = np.random.default_rng(0)
    records: list[dict[str, Any]] = []
    for d in range(25):
        td = f"2026{(1 + d // 28):02d}{(1 + d % 28):02d}"
        for i in range(10):
            features = {"feat0": float(rng.normal())}
            # 大部分行 NaN，仅 15 行真实 label（25*10=250 行总数 → 235 NaN + 15 valid）
            label_val = float("nan") if not (d < 2 and i < 8) else 1.0  # 共 16 valid (d=0:8, d=1:8)
            # 调到 15：把 d=1, i=7 也设成 NaN
            if d == 1 and i == 7:
                label_val = float("nan")
            records.append(
                {
                    "trade_date": td,
                    "ts_code": f"00000{i}.SZ",
                    "features": features,
                    "label": label_val,
                }
            )
    df = pd.DataFrame(records)
    valid = int(df["label"].notna().sum())
    assert valid < 20, f"测试夹具构造错误：valid={valid}，应 < 20"

    monkeypatch.setattr(runner_mod, "_load_feature_matrix", lambda fs, **_: df)
    monkeypatch.setattr(
        runner_mod,
        "gate_check",
        lambda trade_date, *, mode, strict, job_id: None,
    )

    with pytest.raises(ValueError, match=r"有效样本数 \d+ < 20"):
        runner_mod.train_model("fs_v1", seed=42, walk_forward=False)
