"""TDD：entry_features.py 入场特征纯函数单元测试。

纯合成数据，不查 DB，不连 Tushare。
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from quant_pipeline.research.kelly_sweep.entry_features import (
    apply_threshold,
    dev_ma,
    down_streak,
    pick_industry_index,
    rs_vs_index,
    vol_contract,
    vol_regime_percentile,
)


# ===========================================================================
# dev_ma
# ===========================================================================


class TestDevMa:
    def test_below_ma_negative(self) -> None:
        """价格低于均线 → 负值。"""
        assert dev_ma(9.0, 10.0) == pytest.approx(-0.1)

    def test_above_ma_positive(self) -> None:
        """价格高于均线 → 正值。"""
        assert dev_ma(11.0, 10.0) == pytest.approx(0.1)

    def test_at_ma_zero(self) -> None:
        """价格等于均线 → 0。"""
        assert dev_ma(10.0, 10.0) == pytest.approx(0.0)

    def test_series_input(self) -> None:
        """Series 输入应逐元素计算。"""
        close = pd.Series([9.0, 10.0, 11.0])
        ma = pd.Series([10.0, 10.0, 10.0])
        result = dev_ma(close, ma)
        expected = pd.Series([-0.1, 0.0, 0.1])
        pd.testing.assert_series_equal(result, expected)

    def test_formula_is_ratio_minus_one(self) -> None:
        """公式 = close/ma - 1，而非 (close-ma)/ma（结果相同但语义明确）。"""
        assert dev_ma(8.0, 5.0) == pytest.approx(8.0 / 5.0 - 1)


# ===========================================================================
# down_streak
# ===========================================================================


class TestDownStreak:
    def test_empty_series_returns_zero(self) -> None:
        assert down_streak(pd.Series([], dtype=float)) == 0

    def test_all_positive_returns_zero(self) -> None:
        assert down_streak(pd.Series([1.0, 2.0, 0.5])) == 0

    def test_last_day_zero_breaks_streak(self) -> None:
        """最后一日 = 0（非负），不计入连阴。"""
        assert down_streak(pd.Series([-1.0, -2.0, 0.0])) == 0

    def test_three_consecutive_negatives(self) -> None:
        assert down_streak(pd.Series([1.0, -1.0, -1.0, -1.0])) == 3

    def test_streak_interrupted(self) -> None:
        """中间有正值，连阴从尾部数到中断处。"""
        assert down_streak(pd.Series([-1.0, 1.0, -1.0, -1.0])) == 2

    def test_all_negative(self) -> None:
        series = pd.Series([-0.5, -1.0, -2.0, -0.3, -1.5])
        assert down_streak(series) == 5

    def test_single_negative_last(self) -> None:
        assert down_streak(pd.Series([1.0, 2.0, -0.5])) == 1

    def test_nan_breaks_streak(self) -> None:
        """NaN 视为中断（保守），之后的连阴不算。"""
        series = pd.Series([-1.0, float("nan"), -1.0, -1.0])
        # 最后两日连阴，但 nan 在倒数第 3 日 → 连阴 = 2
        assert down_streak(series) == 2

    def test_nan_as_last_element_returns_zero(self) -> None:
        """最后一日为 NaN → 连阴 = 0。"""
        assert down_streak(pd.Series([-1.0, -1.0, float("nan")])) == 0


# ===========================================================================
# vol_contract
# ===========================================================================


class TestVolContract:
    def _make_vol(self, values: list[float]) -> pd.Series:
        return pd.Series(values, dtype=float)

    def test_insufficient_data_returns_nan(self) -> None:
        """序列长度 < 6 → NaN。"""
        assert math.isnan(vol_contract(self._make_vol([100.0] * 5)))

    def test_exactly_six_elements(self) -> None:
        """长度恰好 6：当日=60，过去 5 日均量=100 → 0.6。"""
        vol = self._make_vol([100.0, 100.0, 100.0, 100.0, 100.0, 60.0])
        assert vol_contract(vol) == pytest.approx(0.6)

    def test_contraction_below_one(self) -> None:
        """缩量：当日量 < 历史均量。"""
        vol = self._make_vol([200.0, 200.0, 200.0, 200.0, 200.0, 100.0])
        assert vol_contract(vol) == pytest.approx(0.5)

    def test_expansion_above_one(self) -> None:
        """放量：当日量 > 历史均量。"""
        vol = self._make_vol([100.0, 100.0, 100.0, 100.0, 100.0, 150.0])
        assert vol_contract(vol) == pytest.approx(1.5)

    def test_current_day_excluded_from_denominator(self) -> None:
        """当日不计入分母均量窗口。

        序列 7 个元素：前 5 日（倒数 6~2）均量应为 [10,10,10,10,10] 的均值=10，
        当日（最后一个）= 50，但倒数第 7 位（index 0）= 9999 不应进入分母。
        """
        #            idx: 0      1     2     3     4     5    6（当日）
        vol = self._make_vol([9999.0, 10.0, 10.0, 10.0, 10.0, 10.0, 50.0])
        # 分母 = mean([10,10,10,10,10]) = 10  （iloc[-6:-1] = index 1..5）
        result = vol_contract(vol)
        assert result == pytest.approx(5.0)

    def test_zero_denominator_returns_nan(self) -> None:
        """历史均量=0 → NaN（防除零）。"""
        vol = self._make_vol([0.0, 0.0, 0.0, 0.0, 0.0, 50.0])
        assert math.isnan(vol_contract(vol))

    def test_equal_volume_returns_one(self) -> None:
        """当日量 = 历史均量 → 1.0。"""
        vol = self._make_vol([100.0] * 6)
        assert vol_contract(vol) == pytest.approx(1.0)


# ===========================================================================
# vol_regime_percentile
# ===========================================================================


class TestVolRegimePercentile:
    def _make_df(
        self,
        ts_codes: list[str],
        atr_14: list[float],
        qfq_close: list[float],
    ) -> pd.DataFrame:
        return pd.DataFrame(
            {"ts_code": ts_codes, "atr_14": atr_14, "qfq_close": qfq_close}
        )

    def test_monotone_ordering(self) -> None:
        """atr_14/close 越高 → 分位越大。"""
        df = self._make_df(
            ts_codes=["A", "B", "C", "D"],
            atr_14=[1.0, 2.0, 3.0, 4.0],
            qfq_close=[10.0, 10.0, 10.0, 10.0],
        )
        result = vol_regime_percentile(df)
        # 分位单调递增
        assert list(result) == sorted(result)

    def test_all_equal_same_percentile(self) -> None:
        """所有股票 ratio 相同 → 分位相同（pandas rank pct=True，3 个并列 = 2/3）。

        pandas rank(pct=True, method='average') 对 n 个并列：排名 = (n+1)/2，
        pct = 排名/n = (n+1)/(2n)。
        n=3 → (3+1)/(2*3) = 4/6 = 2/3 ≈ 0.667，而非 0.5。
        """
        df = self._make_df(
            ts_codes=["A", "B", "C"],
            atr_14=[1.0, 1.0, 1.0],
            qfq_close=[10.0, 10.0, 10.0],
        )
        result = vol_regime_percentile(df)
        # 并列时 rank(pct=True) 返回平均排名的百分比，3 元素全并列 → 2/3
        expected_pct = (3 + 1) / (2 * 3)  # = 2/3
        # 逐元素用 pytest.approx 比较，不用 Series.all()（避免 approx 广播语义）
        for val in result:
            assert val == pytest.approx(expected_pct)

    def test_nan_preserved(self) -> None:
        """atr_14 为 NaN 的行 → 输出 NaN（不影响其他行排名）。"""
        df = self._make_df(
            ts_codes=["A", "B", "C"],
            atr_14=[float("nan"), 1.0, 2.0],
            qfq_close=[10.0, 10.0, 10.0],
        )
        result = vol_regime_percentile(df)
        assert math.isnan(result.iloc[0])
        assert not math.isnan(result.iloc[1])
        assert not math.isnan(result.iloc[2])

    def test_zero_close_becomes_nan(self) -> None:
        """qfq_close=0 → ratio=inf/nan → 分位 NaN。"""
        df = self._make_df(
            ts_codes=["A", "B"],
            atr_14=[1.0, 1.0],
            qfq_close=[0.0, 10.0],
        )
        result = vol_regime_percentile(df)
        assert math.isnan(result.iloc[0])

    def test_four_stocks_percentile_range(self) -> None:
        """4 只股票的分位应在 (0, 1] 范围内。"""
        df = self._make_df(
            ts_codes=["A", "B", "C", "D"],
            atr_14=[0.5, 1.0, 1.5, 2.0],
            qfq_close=[10.0, 10.0, 10.0, 10.0],
        )
        result = vol_regime_percentile(df)
        assert (result > 0).all()
        assert (result <= 1).all()

    def test_low_percentile_threshold(self) -> None:
        """最低 ratio 的股票应落在分位 < 0.3 区域（规模够大时）。"""
        n = 10
        df = self._make_df(
            ts_codes=[str(i) for i in range(n)],
            atr_14=[float(i + 1) for i in range(n)],
            qfq_close=[10.0] * n,
        )
        result = vol_regime_percentile(df)
        assert result.iloc[0] <= 0.3


# ===========================================================================
# rs_vs_index
# ===========================================================================


class TestRsVsIndex:
    def _make_close(self, values: list[float]) -> pd.Series:
        return pd.Series(values, dtype=float)

    def test_positive_rs_stock_outperforms(self) -> None:
        """个股涨幅 > 基准 → RS > 0。"""
        # 个股：10 → 12（+20%），基准：100 → 105（+5%）
        stock = self._make_close([10.0, 11.0, 12.0])
        index = self._make_close([100.0, 102.0, 105.0])
        result = rs_vs_index(stock, index, lookback=2)
        assert result == pytest.approx(0.20 - 0.05)

    def test_negative_rs_stock_underperforms(self) -> None:
        """个股跌幅 > 基准 → RS < 0。"""
        # 个股：10 → 9（-10%），基准：100 → 103（+3%）
        stock = self._make_close([10.0, 9.5, 9.0])
        index = self._make_close([100.0, 101.0, 103.0])
        result = rs_vs_index(stock, index, lookback=2)
        assert result == pytest.approx(-0.10 - 0.03)

    def test_zero_rs_same_performance(self) -> None:
        """个股与基准同涨幅 → RS = 0。"""
        stock = self._make_close([10.0, 11.0])
        index = self._make_close([100.0, 110.0])
        result = rs_vs_index(stock, index, lookback=1)
        assert result == pytest.approx(0.0)

    def test_insufficient_stock_data_returns_nan(self) -> None:
        stock = self._make_close([10.0])
        index = self._make_close([100.0, 110.0])
        assert math.isnan(rs_vs_index(stock, index, lookback=1))

    def test_insufficient_index_data_returns_nan(self) -> None:
        stock = self._make_close([10.0, 11.0])
        index = self._make_close([100.0])
        assert math.isnan(rs_vs_index(stock, index, lookback=1))

    def test_signal_before_ths_min_date_returns_nan(self) -> None:
        """signal_date < '20240102' → RS 不可用（THS 硬约束）。"""
        stock = self._make_close([10.0, 11.0, 12.0])
        index = self._make_close([100.0, 102.0, 105.0])
        result = rs_vs_index(stock, index, lookback=2, signal_date="20231231")
        assert math.isnan(result)

    def test_signal_on_ths_min_date_is_valid(self) -> None:
        """signal_date = '20240102' → 可用（边界值）。"""
        stock = self._make_close([10.0, 11.0, 12.0])
        index = self._make_close([100.0, 102.0, 105.0])
        result = rs_vs_index(stock, index, lookback=2, signal_date="20240102")
        assert not math.isnan(result)

    def test_signal_after_ths_min_date_is_valid(self) -> None:
        """signal_date > '20240102' → 可用。"""
        stock = self._make_close([10.0, 11.0, 12.0])
        index = self._make_close([100.0, 102.0, 105.0])
        result = rs_vs_index(stock, index, lookback=2, signal_date="20250101")
        assert not math.isnan(result)

    def test_no_signal_date_no_constraint(self) -> None:
        """不传 signal_date → 不做时间约束（调用方未提供日期时的宽松模式）。"""
        stock = self._make_close([10.0, 11.0])
        index = self._make_close([100.0, 110.0])
        result = rs_vs_index(stock, index, lookback=1)
        assert not math.isnan(result)

    def test_lookback_5_uses_correct_window(self) -> None:
        """lookback=5 时用 iloc[-6] 与 iloc[-1] 作为 prev/now。

        长度 7：idx 0..6。iloc[-6] = idx 1，iloc[-1] = idx 6。
        stock[1]=10.0, stock[6]=11.0 → ret = 11/10 - 1 = 0.1
        index 全 100 → ret_index = 0
        """
        #               idx: 0      1      2      3      4      5      6
        stock_vals = [9.0, 10.0, 10.2, 10.5, 10.8, 10.9, 11.0]
        index_vals = [100.0, 100.0, 100.0, 100.0, 100.0, 100.0, 100.0]
        stock = self._make_close(stock_vals)
        index = self._make_close(index_vals)
        result = rs_vs_index(stock, index, lookback=5)
        # ret_stock = 11.0/10.0 - 1 = 0.1; ret_index = 100/100 - 1 = 0
        assert result == pytest.approx(0.1)


# ===========================================================================
# pick_industry_index
# ===========================================================================


class TestPickIndustryIndex:
    def _make_member_df(
        self,
        rows: list[tuple[str, str, str]],
    ) -> pd.DataFrame:
        """rows: [(con_code, index_code, type), ...]"""
        return pd.DataFrame(rows, columns=["con_code", "index_code", "type"])

    def test_no_type_i_returns_none(self) -> None:
        """无 type=I 行业指数 → None。"""
        df = self._make_member_df(
            [("000001.SZ", "884001.TI", "N")]
        )
        assert pick_industry_index(df, "000001.SZ") is None

    def test_stock_not_in_df_returns_none(self) -> None:
        df = self._make_member_df(
            [("000002.SZ", "884001.TI", "I")]
        )
        assert pick_industry_index(df, "000001.SZ") is None

    def test_single_industry_returns_it(self) -> None:
        """只属于一个 type=I 行业指数 → 直接返回该指数。"""
        df = self._make_member_df(
            [
                ("000001.SZ", "884001.TI", "I"),
                ("000002.SZ", "884001.TI", "I"),
                ("000003.SZ", "884001.TI", "I"),
            ]
        )
        assert pick_industry_index(df, "000001.SZ") == "884001.TI"

    def test_picks_most_members_industry(self) -> None:
        """多个行业，取成份股数最多者。

        行业 884001: 3 只股（000001,000002,000003）
        行业 884002: 2 只股（000001,000004）
        → 应选 884001。
        """
        df = self._make_member_df(
            [
                ("000001.SZ", "884001.TI", "I"),
                ("000001.SZ", "884002.TI", "I"),
                ("000002.SZ", "884001.TI", "I"),
                ("000003.SZ", "884001.TI", "I"),
                ("000004.SZ", "884002.TI", "I"),
            ]
        )
        result = pick_industry_index(df, "000001.SZ")
        assert result == "884001.TI"

    def test_tie_broken_by_lexicographic_order(self) -> None:
        """并列时按 index_code 字典序升序取第一。

        两个行业各 2 只股：884001 vs 884002，字典序 884001 < 884002 → 取 884001。
        """
        df = self._make_member_df(
            [
                ("000001.SZ", "884001.TI", "I"),
                ("000001.SZ", "884002.TI", "I"),
                ("000002.SZ", "884001.TI", "I"),
                ("000003.SZ", "884002.TI", "I"),
            ]
        )
        result = pick_industry_index(df, "000001.SZ")
        assert result == "884001.TI"

    def test_concept_type_ignored(self) -> None:
        """type=N（概念）不参与选取，仅 type=I 计入。"""
        df = self._make_member_df(
            [
                ("000001.SZ", "884001.TI", "N"),   # 概念，忽略
                ("000001.SZ", "884002.TI", "I"),   # 行业，有效
                ("000002.SZ", "884001.TI", "N"),
                ("000003.SZ", "884002.TI", "I"),
                ("000004.SZ", "884002.TI", "I"),
            ]
        )
        result = pick_industry_index(df, "000001.SZ")
        assert result == "884002.TI"

    def test_picks_wider_industry_for_reproducibility(self) -> None:
        """成份股最多 → 最广义行业，保证可复现（spec 02§3.2）。"""
        # 行业 A(884001): 5 只成份股，行业 B(884002): 3 只
        members = (
            [("000001.SZ", "884001.TI", "I"), ("000001.SZ", "884002.TI", "I")]
            + [(f"00000{i}.SZ", "884001.TI", "I") for i in range(2, 6)]
            + [("000006.SZ", "884002.TI", "I"), ("000007.SZ", "884002.TI", "I")]
        )
        df = self._make_member_df(members)
        result = pick_industry_index(df, "000001.SZ")
        assert result == "884001.TI"


# ===========================================================================
# apply_threshold
# ===========================================================================


class TestApplyThreshold:
    def _series(self) -> pd.Series:
        return pd.Series([-0.1, -0.05, 0.0, 0.03, 0.08])

    def test_lt(self) -> None:
        mask = apply_threshold(self._series(), "lt", 0.0)
        assert list(mask) == [True, True, False, False, False]

    def test_lte(self) -> None:
        mask = apply_threshold(self._series(), "lte", 0.0)
        assert list(mask) == [True, True, True, False, False]

    def test_gt(self) -> None:
        mask = apply_threshold(self._series(), "gt", 0.0)
        assert list(mask) == [False, False, False, True, True]

    def test_gte(self) -> None:
        mask = apply_threshold(self._series(), "gte", 0.0)
        assert list(mask) == [False, False, True, True, True]

    def test_eq(self) -> None:
        mask = apply_threshold(self._series(), "eq", 0.0)
        assert list(mask) == [False, False, True, False, False]

    def test_neq(self) -> None:
        mask = apply_threshold(self._series(), "neq", 0.0)
        assert list(mask) == [True, True, False, True, True]

    def test_invalid_op_raises(self) -> None:
        with pytest.raises(ValueError, match="op"):
            apply_threshold(self._series(), "invalid", 0.0)  # type: ignore[arg-type]

    def test_nan_returns_false(self) -> None:
        """NaN 值在任何 op 下均返回 False（安全保守）。"""
        s = pd.Series([float("nan"), -0.1, 0.05])
        mask = apply_threshold(s, "lt", 0.0)
        assert list(mask) == [False, True, False]

    def test_and_combination(self) -> None:
        """两个掩码 AND 组合：dev_ma < -3% AND down_streak >= 3。"""
        dev = pd.Series([-0.05, -0.02, -0.04, -0.01])
        streak = pd.Series([4, 2, 3, 5])
        mask = apply_threshold(dev, "lt", -0.03) & apply_threshold(streak, "gte", 3.0)
        assert list(mask) == [True, False, True, False]
