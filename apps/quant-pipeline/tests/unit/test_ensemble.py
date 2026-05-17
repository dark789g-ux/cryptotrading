"""Ensemble 单测（M3 Part I）。

覆盖：
  - cross_sectional_zscore：同日 mean=0
  - ensemble_average 等权平均后形状对
  - 长度不一致抛 ValueError
"""

from __future__ import annotations

import numpy as np
import pytest

from quant_pipeline.training.ensemble import cross_sectional_zscore, ensemble_average


def test_cross_sectional_zscore_zero_mean_per_day() -> None:
    scores = np.array([1.0, 2.0, 3.0, 10.0, 20.0, 30.0])
    dates = ["20260101", "20260101", "20260101", "20260102", "20260102", "20260102"]
    z = cross_sectional_zscore(scores, dates)
    # 同日 z-score 之和应近似 0
    assert abs(float(z[:3].sum())) < 1e-9
    assert abs(float(z[3:].sum())) < 1e-9


def test_cross_sectional_zscore_zero_std_returns_zero() -> None:
    # 同日所有 score 相同 → std=0 → 输出 0
    scores = np.array([5.0, 5.0, 5.0])
    dates = ["20260101", "20260101", "20260101"]
    z = cross_sectional_zscore(scores, dates)
    assert np.allclose(z, 0.0)


def test_ensemble_average_equal_weight() -> None:
    n = 10
    dates = ["20260101"] * 5 + ["20260102"] * 5
    rng = np.random.default_rng(0)
    s1 = rng.normal(size=n)
    s2 = rng.normal(size=n) * 100  # 完全不同量纲
    s3 = rng.normal(size=n) * 0.01
    out = ensemble_average({"a": s1, "b": s2, "c": s3}, dates)
    assert out.shape == (n,)
    # 不应被大量纲 s2 主导（z-score 抹平量纲）
    assert abs(float(out[:5].mean())) < 1e-6  # 同日 z-score 平均后均值应近 0


def test_ensemble_average_length_mismatch() -> None:
    with pytest.raises(ValueError, match="一致"):
        ensemble_average(
            {"a": np.array([1.0, 2.0]), "b": np.array([1.0, 2.0, 3.0])},
            ["20260101", "20260101"],
        )


def test_ensemble_average_weight_normalization() -> None:
    """指定 weights 时应按权重平均（手工核对一组简单 case）。"""

    dates = ["20260101", "20260101"]
    s1 = np.array([1.0, -1.0])  # z-score: [1, -1] (std=sqrt(2))
    s2 = np.array([-1.0, 1.0])  # z-score: [-1, 1]
    out = ensemble_average({"a": s1, "b": s2}, dates, weights={"a": 1.0, "b": 1.0})
    # 等权平均后应为 0
    assert np.allclose(out, 0.0, atol=1e-9)


def test_ensemble_average_empty_raises() -> None:
    with pytest.raises(ValueError):
        ensemble_average({}, ["20260101"])
