"""labels/classify.py 单测（分类后移，spec 2026-06-05 §测试矩阵）。

覆盖：
  - band 边界 r==±ε 落横盘、r>ε 涨、r<−ε 跌（|r|≤ε 闭区间）
  - tercile 截面三分位、平票稳定处理
  - custom 阈值分桶
  - NaN 处理（NaN label 保留 NaN，不产假类别）
  - 误配参数 raise
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.labels.classify import (
    _CLS_DOWN,
    _CLS_FLAT,
    _CLS_UP,
    classify,
)

# ─────────────────────── band ─────────────────────────────────────────────────

class TestClassifyBand:
    """band 模式：|r| ≤ eps 判横盘（闭区间）。"""

    def test_boundary_exact_eps_flat(self) -> None:
        """r == ±ε 精确落横盘（|r| ≤ ε 闭区间）。"""
        eps = 0.005
        bump = eps * 1e-3
        values = pd.Series([-eps - bump, -eps, 0.0, eps, eps + bump])
        out = classify(values, "band", {"eps": eps})
        assert out.tolist() == [_CLS_DOWN, _CLS_FLAT, _CLS_FLAT, _CLS_FLAT, _CLS_UP]

    def test_positive_return_above_eps_up(self) -> None:
        eps = 0.01
        out = classify(pd.Series([0.02]), "band", {"eps": eps})
        assert out.iloc[0] == _CLS_UP

    def test_negative_return_below_eps_down(self) -> None:
        eps = 0.01
        out = classify(pd.Series([-0.02]), "band", {"eps": eps})
        assert out.iloc[0] == _CLS_DOWN

    def test_zero_flat(self) -> None:
        eps = 0.005
        out = classify(pd.Series([0.0]), "band", {"eps": eps})
        assert out.iloc[0] == _CLS_FLAT

    def test_nan_preserved(self) -> None:
        """NaN label 保留 NaN，不产假类别。"""
        values = pd.Series([0.1, float("nan"), -0.1])
        out = classify(values, "band", {"eps": 0.005})
        assert out.iloc[0] == _CLS_UP
        assert np.isnan(out.iloc[1])
        assert out.iloc[2] == _CLS_DOWN

    def test_missing_eps_raises(self) -> None:
        with pytest.raises(ValueError, match="eps"):
            classify(pd.Series([0.01]), "band", {})

    def test_eps_zero_raises(self) -> None:
        with pytest.raises(ValueError, match="eps.*> 0"):
            classify(pd.Series([0.01]), "band", {"eps": 0.0})

    def test_eps_negative_raises(self) -> None:
        with pytest.raises(ValueError, match="eps.*> 0"):
            classify(pd.Series([0.01]), "band", {"eps": -0.005})


# ─────────────────────── tercile ──────────────────────────────────────────────

class TestClassifyTercile:
    """tercile 模式：截面三分位；每个 trade_date 截面独立。"""

    def _run(self, rets: list[float], dates: list[str]) -> pd.Series:
        return classify(
            pd.Series(rets),
            "tercile",
            {},
            trade_date=pd.Series(dates),
        )

    def test_basic_3_stocks_even_split(self) -> None:
        """3 只票单截面 → 低→跌、中→横、高→涨。"""
        out = self._run([-0.05, 0.0, 0.05], ["20240102"] * 3)
        assert out.tolist() == [_CLS_DOWN, _CLS_FLAT, _CLS_UP]

    def test_9_stocks_equal_count(self) -> None:
        """9 只票单截面 → 各 3 只跌/横/涨。"""
        rets = [-0.10, -0.05, -0.02, 0.0, 0.01, 0.02, 0.05, 0.08, 0.12]
        dates = ["20240102"] * 9
        out = self._run(rets, dates)
        counts = pd.Series(out).value_counts().to_dict()
        assert counts[_CLS_DOWN] == 3
        assert counts[_CLS_FLAT] == 3
        assert counts[_CLS_UP] == 3

    def test_ties_stable_sort(self) -> None:
        """平票（全并列）按稳定排序原序切分，可复现。
        6 只票 r=0.01 全并列，n=6 → lo=2 hi=4：前 2 跌、中 2 横、后 2 涨。
        """
        out = self._run([0.01] * 6, ["20240102"] * 6)
        assert out.iloc[0] == _CLS_DOWN
        assert out.iloc[1] == _CLS_DOWN
        assert out.iloc[2] == _CLS_FLAT
        assert out.iloc[3] == _CLS_FLAT
        assert out.iloc[4] == _CLS_UP
        assert out.iloc[5] == _CLS_UP

    def test_ties_reproducible(self) -> None:
        """平票结果可复现（连续调用两次结果完全一致）。"""
        values = pd.Series([0.01] * 6)
        dates = pd.Series(["20240102"] * 6)
        out1 = classify(values, "tercile", {}, trade_date=dates)
        out2 = classify(values, "tercile", {}, trade_date=dates)
        pd.testing.assert_series_equal(out1.reset_index(drop=True), out2.reset_index(drop=True))

    def test_two_sections_independent(self) -> None:
        """两个截面独立计算，不跨截面混算。"""
        rets = [-0.05, 0.0, 0.05,    # 截面 A（日 01）
                 0.10, 0.20, 0.30]   # 截面 B（日 02）
        dates = ["20240101", "20240101", "20240101",
                 "20240102", "20240102", "20240102"]
        out = self._run(rets, dates)
        # 截面 A 内独立三分：低→跌、中→横、高→涨
        assert out.iloc[0] == _CLS_DOWN
        assert out.iloc[1] == _CLS_FLAT
        assert out.iloc[2] == _CLS_UP
        # 截面 B 内独立三分（相对大小，不与 A 混）
        assert out.iloc[3] == _CLS_DOWN
        assert out.iloc[4] == _CLS_FLAT
        assert out.iloc[5] == _CLS_UP

    def test_nan_preserved(self) -> None:
        values = pd.Series([-0.05, float("nan"), 0.05])
        out = classify(values, "tercile", {}, trade_date=pd.Series(["20240102"] * 3))
        assert np.isnan(out.iloc[1])
        assert not np.isnan(out.iloc[0])
        assert not np.isnan(out.iloc[2])

    def test_missing_trade_date_raises(self) -> None:
        with pytest.raises(ValueError, match="trade_date"):
            classify(pd.Series([0.01, -0.01]), "tercile", {})

    def test_length_mismatch_raises(self) -> None:
        with pytest.raises(ValueError, match="length"):
            classify(
                pd.Series([0.01, -0.01]),
                "tercile",
                {},
                trade_date=pd.Series(["20240102"]),
            )


# ─────────────────────── custom ───────────────────────────────────────────────

class TestClassifyCustom:
    """custom 模式：自定义阈值边界。"""

    def test_basic_thresholds(self) -> None:
        """r < lo → 跌；lo ≤ r ≤ hi → 横；r > hi → 涨。"""
        values = pd.Series([-0.02, -0.01, 0.0, 0.01, 0.02])
        out = classify(values, "custom", {"thresholds": [-0.01, 0.01]})
        assert out.tolist() == [_CLS_DOWN, _CLS_FLAT, _CLS_FLAT, _CLS_FLAT, _CLS_UP]

    def test_negative_thresholds(self) -> None:
        out = classify(pd.Series([-0.05, -0.03, -0.01]), "custom", {"thresholds": [-0.04, -0.02]})
        assert out.iloc[0] == _CLS_DOWN
        assert out.iloc[1] == _CLS_FLAT
        assert out.iloc[2] == _CLS_UP

    def test_missing_thresholds_raises(self) -> None:
        with pytest.raises(ValueError, match="thresholds"):
            classify(pd.Series([0.01]), "custom", {})

    def test_lo_ge_hi_raises(self) -> None:
        with pytest.raises(ValueError, match="lo < hi"):
            classify(pd.Series([0.01]), "custom", {"thresholds": [0.01, 0.01]})

    def test_nan_preserved(self) -> None:
        values = pd.Series([0.05, float("nan"), -0.05])
        out = classify(values, "custom", {"thresholds": [-0.01, 0.01]})
        assert np.isnan(out.iloc[1])


# ─────────────────────── 通用错误 ─────────────────────────────────────────────

def test_invalid_mode_raises() -> None:
    with pytest.raises(ValueError, match="mode"):
        classify(pd.Series([0.01]), "dir3_band", {})


def test_empty_values_band() -> None:
    """空 values → 空 Series。"""
    out = classify(pd.Series([], dtype=float), "band", {"eps": 0.005})
    assert len(out) == 0
