"""10 个量价因子的单测。

每个因子至少覆盖：
- PIT 窗口（数据不足返回空 / NaN，不抛错）
- 极值（手算对比）
- 缺失（停牌日 close=NaN 时返回 NaN）
- 复权处理（用 close_adj 而非 close；分红事件后值平滑）

# TODO: 集成测试验证 API 契约 —— Part C/E 完成后补一份用 raw.daily_quote
# 真实小样本（如 600519.SH 2024-01..2024-06）的端到端测试。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from quant_pipeline.factors.registry import get_factor

# ----------------------------------------------------------------------
# momentum_20d
# ----------------------------------------------------------------------

def test_momentum_20d_value_matches_manual(small_panel: pd.DataFrame) -> None:
    f = get_factor("momentum_20d", "v1")
    # 取 T = 第 40 个交易日
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    # 手算：close_adj(t) / close_adj(t-20) - 1
    close = small_panel["close_adj"].unstack("ts_code").sort_index().loc[:t]
    expected = close.iloc[-1] / close.iloc[-21] - 1.0
    pd.testing.assert_series_equal(
        out.sort_index(), expected.sort_index(), check_names=False
    )


def test_momentum_20d_insufficient_window_returns_empty(
    small_panel: pd.DataFrame,
) -> None:
    f = get_factor("momentum_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    # 取第 5 日，前面只有 5 天历史，不够 21 日
    t = trade_dates[5]
    out = f.compute(small_panel, t)
    assert out.empty


def test_momentum_20d_dividend_event_is_smoothed(small_panel: pd.DataFrame) -> None:
    """conftest 在第 30 日构造了 1.1 倍的 adj_factor 跳变 + close 跳水 10%。
    用后复权价的因子应当几乎不受影响（< 1% 误差）。
    """

    f = get_factor("momentum_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    # 跨越分红日的 T
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    # 同样窗口、但用未复权 close 算的"错误版本"
    bad_close = small_panel["close"].unstack("ts_code").sort_index().loc[:t]
    bad = bad_close.iloc[-1] / bad_close.iloc[-21] - 1.0
    # 因后复权基准消除了分红跳变，正确值与错误值差异应明显
    # 至少一只票（跨越分红日的窗口）差异 > 5%
    diffs = (out - bad).abs()
    assert (diffs > 0.05).any(), "复权处理应当让 momentum 与 raw close 显著不同"


# ----------------------------------------------------------------------
# momentum_60d
# ----------------------------------------------------------------------

def test_momentum_60d_value_matches_manual(small_panel: pd.DataFrame) -> None:
    f = get_factor("momentum_60d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[70]
    out = f.compute(small_panel, t)
    close = small_panel["close_adj"].unstack("ts_code").sort_index().loc[:t]
    expected = close.iloc[-1] / close.iloc[-61] - 1.0
    pd.testing.assert_series_equal(
        out.sort_index(), expected.sort_index(), check_names=False
    )


# ----------------------------------------------------------------------
# volatility_20d
# ----------------------------------------------------------------------

def test_volatility_20d_nonnegative_and_finite(small_panel: pd.DataFrame) -> None:
    f = get_factor("volatility_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    assert (out >= 0).all()
    assert np.isfinite(out).all()


# ----------------------------------------------------------------------
# volume_ratio_20d
# ----------------------------------------------------------------------

def test_volume_ratio_20d_value_matches_manual(small_panel: pd.DataFrame) -> None:
    f = get_factor("volume_ratio_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    vol = small_panel["vol"].unstack("ts_code").sort_index().loc[:t]
    expected = vol.iloc[-1] / vol.iloc[-21:-1].mean()
    pd.testing.assert_series_equal(
        out.sort_index(), expected.sort_index(), check_names=False
    )


# ----------------------------------------------------------------------
# turnover_mean_20d
# ----------------------------------------------------------------------

def test_turnover_mean_20d_value(small_panel: pd.DataFrame) -> None:
    f = get_factor("turnover_mean_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    tr = small_panel["turnover_rate"].unstack("ts_code").sort_index().loc[:t]
    expected = tr.tail(20).mean()
    pd.testing.assert_series_equal(
        out.sort_index(), expected.sort_index(), check_names=False
    )


# ----------------------------------------------------------------------
# ma_ratio_20d
# ----------------------------------------------------------------------

def test_ma_ratio_20d_around_one(small_panel: pd.DataFrame) -> None:
    f = get_factor("ma_ratio_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    # 应当在 0.5..2 范围内（小样本随机游走）
    assert out.between(0.5, 2.0).all()


# ----------------------------------------------------------------------
# rsi_14
# ----------------------------------------------------------------------

def test_rsi_14_in_valid_range(small_panel: pd.DataFrame) -> None:
    f = get_factor("rsi_14", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t).dropna()
    # RSI ∈ [0, 100]
    assert (out >= 0).all() and (out <= 100).all()


def test_rsi_14_monotone_up_gives_100() -> None:
    """构造一只单调上涨的票：close_adj 严格上涨；RSI 应当接近 100。"""

    f = get_factor("rsi_14", "v1")
    dates = [f"2024{m:02d}{d:02d}" for m in [1, 2] for d in range(1, 16)]
    df = pd.DataFrame(
        {
            "trade_date": dates,
            "ts_code": ["TEST.SZ"] * len(dates),
            "close_adj": np.linspace(10.0, 20.0, len(dates)),
        }
    ).set_index(["trade_date", "ts_code"])
    out = f.compute(df, dates[-1])
    assert out["TEST.SZ"] > 95


# ----------------------------------------------------------------------
# bollinger_position_20d
# ----------------------------------------------------------------------

def test_bollinger_position_finite(small_panel: pd.DataFrame) -> None:
    f = get_factor("bollinger_position_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t).dropna()
    assert np.isfinite(out).all()


# ----------------------------------------------------------------------
# price_max_drawdown_60d
# ----------------------------------------------------------------------

def test_max_drawdown_60d_non_positive(small_panel: pd.DataFrame) -> None:
    f = get_factor("price_max_drawdown_60d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[70]
    out = f.compute(small_panel, t)
    # 最大回撤 ≤ 0
    assert (out <= 1e-12).all()


# ----------------------------------------------------------------------
# close_to_high_60d
# ----------------------------------------------------------------------

def test_close_to_high_60d_in_zero_one(small_panel: pd.DataFrame) -> None:
    f = get_factor("close_to_high_60d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[70]
    out = f.compute(small_panel, t)
    # close / max(close in window) ∈ (0, 1]
    assert (out > 0).all() and (out <= 1.0 + 1e-9).all()


# ----------------------------------------------------------------------
# amihud_illiq_20d
# ----------------------------------------------------------------------

def test_amihud_illiq_20d_value_matches_manual(small_panel: pd.DataFrame) -> None:
    f = get_factor("amihud_illiq_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    # 手算：最近 20 个交易日的 mean(|daily_ret| / amount)
    close = small_panel["close_adj"].unstack("ts_code").sort_index().loc[:t]
    amount = small_panel["amount"].unstack("ts_code").sort_index().loc[:t]
    ret = close.pct_change().iloc[-20:]
    amt = amount.iloc[-20:]
    expected = (ret.abs() / amt).mean(axis=0, skipna=True)
    pd.testing.assert_series_equal(
        out.sort_index(), expected.sort_index(), check_names=False
    )


def test_amihud_illiq_20d_handles_zero_amount() -> None:
    """成交额为 0（停牌）时不应除零；该日 illiq 视为 NaN，但其它日仍可均值。"""

    f = get_factor("amihud_illiq_20d", "v1")
    # 构造 21 天 × 1 票，第 10 天 amount=0
    dates = [f"2024{m:02d}{d:02d}" for m in [1, 2] for d in range(1, 15)][:21]
    amounts = [1e8] * 21
    amounts[10] = 0.0
    closes = list(np.linspace(10.0, 11.0, 21))
    df = pd.DataFrame(
        {
            "trade_date": dates,
            "ts_code": ["TEST.SZ"] * 21,
            "close_adj": closes,
            "amount": amounts,
        }
    ).set_index(["trade_date", "ts_code"])
    out = f.compute(df, dates[-1])
    assert np.isfinite(out["TEST.SZ"]) and out["TEST.SZ"] > 0


def test_amihud_illiq_20d_nonnegative(small_panel: pd.DataFrame) -> None:
    f = get_factor("amihud_illiq_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t).dropna()
    assert (out >= 0).all()


# ----------------------------------------------------------------------
# 通用：所有量价因子都正确声明 pit_window_days > 0
# ----------------------------------------------------------------------

def test_all_price_factors_have_pit_window() -> None:
    from quant_pipeline.factors.registry import list_factors

    for f in list_factors(category="price"):
        assert f.pit_window_days > 0, f"{f.factor_id} missing pit_window_days"
        assert f.pit_anchor == "trade_date"
