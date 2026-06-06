"""strategy/exit_rules.py 第二批单测（spec 2026-06-06 量化策略管理）。

覆盖新增能力：
  - TakeProfitRule（达/未达 target；成交价 = entry×(1+pct)；越界 raise）
  - TrailingStopRule（peak 跟踪；close 跌破 peak×(1−pct) 触发；单调上涨不触发；越界 raise）
  - MABreakRule(period)（period=5 与原 MA5BreakRule 逐行相等；period≠5 用对应 MA 窗口）
  - 模拟器 peak/high 注入（peak 单调不降、出场点正确）
  - build_exit_rules 工厂（合法 5 种 / 空 / 未知 type / 无 max_hold / 多条同 type / 越界 raise）
  - **回归等价测（最关键）**：build_exit_rules(default_exit.exit_rules) 的规则链对固定
    输入，simulate_exit 结果与 default_rules() 逐行相等（value/exit_reason/hold_days/exit_date）。

纯 pandas，不连 DB / 不依赖 lightgbm / torch。
"""

from __future__ import annotations

import pandas as pd
import pytest

from quant_pipeline.strategy.exit_rules import (
    EXIT_BELOW_MA5,
    EXIT_TAKE_PROFIT,
    EXIT_TRAILING_STOP,
    MA_WINDOW,
    MA5BreakRule,
    MABreakRule,
    MaxHoldRule,
    TakeProfitRule,
    TrailingStopRule,
    _ensure_ma,
    build_exit_rules,
    combine_rules,
    default_rules,
    simulate_exit,
)


def _build_quotes(rows: list[dict]) -> pd.DataFrame:
    df = pd.DataFrame(rows)
    df["trade_date"] = df["trade_date"].astype(str)
    return df


# ----------------------------------------------------------------------
# TakeProfitRule
# ----------------------------------------------------------------------

def test_take_profit_triggers_when_high_reaches_target() -> None:
    """盘中 high 触及 entry×(1+pct) → 出场，成交价 = target（非 high）。"""

    rule = TakeProfitRule(pct=0.10)
    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9, "high": 10.0},
        # high=11.5 >= target=11.0；成交价应为 target=11.0，不是 high=11.5
        {"trade_date": "20240103", "close": 10.8, "low": 10.5, "high": 11.5},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=combine_rules([rule, MaxHoldRule()]),
        ma_window=None,
    )
    assert out is not None
    assert out.exit_reason == EXIT_TAKE_PROFIT
    assert out.exit_date == "20240103"
    assert out.exit_price == pytest.approx(11.0)


def test_take_profit_not_triggered_when_high_below_target() -> None:
    """high 未达 target → 不触发（走 force_close 兜底）。"""

    rule = TakeProfitRule(pct=0.20)  # target=12.0
    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9, "high": 10.1},
        {"trade_date": "20240103", "close": 10.8, "low": 10.5, "high": 11.5},  # < 12
    ]
    quotes = _build_quotes(rows)
    state_target_not_reached = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=combine_rules([rule, MaxHoldRule()]),
        ma_window=None,
    )
    assert state_target_not_reached is not None
    assert state_target_not_reached.exit_reason != EXIT_TAKE_PROFIT


@pytest.mark.parametrize("bad", [0.0, -0.1, 5.0001, True, "0.1"])
def test_take_profit_pct_out_of_range_raises(bad: object) -> None:
    with pytest.raises(ValueError):
        TakeProfitRule(pct=bad)  # type: ignore[arg-type]


def test_take_profit_pct_upper_bound_5_accepted() -> None:
    TakeProfitRule(pct=5.0)  # 上界闭区间，不抛即通过


# ----------------------------------------------------------------------
# TrailingStopRule
# ----------------------------------------------------------------------

def test_trailing_stop_triggers_on_drawdown_from_peak() -> None:
    """峰值后 close 跌破 peak×(1−pct) → 出场。"""

    rule = TrailingStopRule(pct=0.10)
    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9, "high": 10.0},
        {"trade_date": "20240103", "close": 12.0, "low": 11.5, "high": 12.5},  # peak=12.5
        # stop = 12.5*0.9 = 11.25；close=11.0 <= 11.25 → 触发，成交价 = close
        {"trade_date": "20240104", "close": 11.0, "low": 10.8, "high": 11.2},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=combine_rules([rule, MaxHoldRule()]),
        ma_window=None,
    )
    assert out is not None
    assert out.exit_reason == EXIT_TRAILING_STOP
    assert out.exit_date == "20240104"
    assert out.exit_price == pytest.approx(11.0)


def test_trailing_stop_monotonic_rise_does_not_trigger() -> None:
    """单调上涨 → 永远不回撤 → trailing_stop 不触发（走 max_hold/force_close）。"""

    rule = TrailingStopRule(pct=0.10)
    dates = pd.bdate_range("2024-01-02", periods=10).strftime("%Y%m%d").tolist()
    rows = [
        {"trade_date": d, "close": 10.0 + i, "low": 9.9 + i, "high": 10.1 + i}
        for i, d in enumerate(dates)
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date=dates[0],
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=combine_rules([rule, MaxHoldRule()]),
        ma_window=None,
    )
    assert out is not None
    assert out.exit_reason != EXIT_TRAILING_STOP


@pytest.mark.parametrize("bad", [0.0, 1.0, -0.1, 1.5, True, "0.1"])
def test_trailing_stop_pct_out_of_range_raises(bad: object) -> None:
    with pytest.raises(ValueError):
        TrailingStopRule(pct=bad)  # type: ignore[arg-type]


# ----------------------------------------------------------------------
# 模拟器 peak/high 注入正确性
# ----------------------------------------------------------------------

def test_simulator_peak_tracks_running_max_high() -> None:
    """含盘中新高的序列：trailing_stop 用持仓期峰值（含盘中 high），而非 close 峰值。

    构造：close 平稳但某日 high 冲高建立 peak，之后 close 回撤越过 peak×(1−pct)。
    若 peak 误用 close（无盘中 high），则不会触发——本测试守 peak 取 high 的运行峰值。
    """

    rule = TrailingStopRule(pct=0.10)
    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9, "high": 10.0},
        # 盘中冲到 high=13.0，close=12.5 > stop(13.0*0.9=11.7) → 当日不触发，peak 记 13.0
        {"trade_date": "20240103", "close": 12.5, "low": 11.8, "high": 13.0},
        # peak 仍 13.0（高于当日 high 12.0）→ stop=11.7；close=11.5 <= 11.7 → 触发。
        # 若 peak 误用 close 峰值 12.5 → stop=11.25，close 11.5 不触发，测试会失败。
        {"trade_date": "20240104", "close": 11.5, "low": 11.3, "high": 12.0},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102",
        ts_code="000001.SZ",
        prices_df=quotes,
        rules=combine_rules([rule, MaxHoldRule()]),
        ma_window=None,
    )
    assert out is not None
    assert out.exit_reason == EXIT_TRAILING_STOP
    assert out.exit_date == "20240104"


# ----------------------------------------------------------------------
# MABreakRule(period) 泛化
# ----------------------------------------------------------------------

def test_ma_break_period5_equals_legacy_ma5() -> None:
    """MABreakRule(5) 与 MA5BreakRule() 对同一序列逐行等价（回归安全）。"""

    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.8, "high": 10.1},
        {"trade_date": "20240103", "close": 10.2, "low": 10.0, "high": 10.3},
        {"trade_date": "20240104", "close": 10.4, "low": 10.2, "high": 10.5},
        {"trade_date": "20240105", "close": 10.6, "low": 10.4, "high": 10.7},
        {"trade_date": "20240108", "close": 10.8, "low": 10.6, "high": 10.9},
        {"trade_date": "20240109", "close": 11.0, "low": 10.8, "high": 11.1},
        {"trade_date": "20240110", "close": 10.2, "low": 10.0, "high": 10.3},  # 跌破 MA5
    ]
    quotes = _build_quotes(rows)
    out_generic = simulate_exit(
        buy_date="20240102", ts_code="X", prices_df=quotes,
        rules=combine_rules([MABreakRule(5), MaxHoldRule()]), ma_window=5,
    )
    out_legacy = simulate_exit(
        buy_date="20240102", ts_code="X", prices_df=quotes,
        rules=combine_rules([MA5BreakRule(), MaxHoldRule()]), ma_window=5,
    )
    assert out_generic is not None and out_legacy is not None
    assert out_generic.exit_reason == out_legacy.exit_reason == EXIT_BELOW_MA5
    assert out_generic.exit_date == out_legacy.exit_date
    assert out_generic.exit_price == out_legacy.exit_price
    assert out_generic.hold_days == out_legacy.hold_days


def test_ma_break_period_other_than_5_uses_its_window() -> None:
    """MABreakRule(period=3) 用 3 日 MA：reason 仍 'ma5_break'（下游禁改名）。

    构造一段让 MA3 先于 MA5 跌破的序列，验证 period 改变 MA 窗口确实生效。
    """

    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.9, "high": 10.0},
        {"trade_date": "20240103", "close": 11.0, "low": 10.9, "high": 11.0},
        {"trade_date": "20240104", "close": 12.0, "low": 11.9, "high": 12.0},
        # MA3(d4)=(11+12+11.0)/3=11.33；close=11.0 < MA3 → 触发（MA5 此刻数据不足）
        {"trade_date": "20240105", "close": 11.0, "low": 10.9, "high": 11.0},
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102", ts_code="X", prices_df=quotes,
        rules=combine_rules([MABreakRule(3), MaxHoldRule()]), ma_window=3,
    )
    assert out is not None
    assert out.exit_reason == EXIT_BELOW_MA5
    assert out.exit_date == "20240105"


@pytest.mark.parametrize("bad", [1, 251, True, 5.0, "5"])
def test_ma_break_period_out_of_range_raises(bad: object) -> None:
    with pytest.raises(ValueError):
        MABreakRule(period=bad)  # type: ignore[arg-type]


# ----------------------------------------------------------------------
# build_exit_rules 工厂
# ----------------------------------------------------------------------

def test_build_exit_rules_all_five_types() -> None:
    """5 种 type 全部合法实例化；ma_window 取 ma_break period。"""

    cfg = [
        {"type": "stop_loss", "params": {"pct": 0.08}},
        {"type": "ma_break", "params": {"period": 10}},
        {"type": "take_profit", "params": {"pct": 0.15}},
        {"type": "trailing_stop", "params": {"pct": 0.10}},
        {"type": "max_hold", "params": {"days": 20}},
    ]
    rule, ma_window = build_exit_rules(cfg)
    assert ma_window == 10
    assert rule is not None


def test_build_exit_rules_no_ma_break_returns_none_window() -> None:
    """无 ma_break → ma_window=None（ma 列恒 NaN）。"""

    cfg = [
        {"type": "stop_loss", "params": {"pct": 0.08}},
        {"type": "max_hold", "params": {"days": 20}},
    ]
    rule, ma_window = build_exit_rules(cfg)
    assert ma_window is None
    assert rule is not None


def test_build_exit_rules_empty_raises() -> None:
    with pytest.raises(ValueError, match="非空"):
        build_exit_rules([])


def test_build_exit_rules_unknown_type_raises() -> None:
    with pytest.raises(ValueError, match="未知 type"):
        build_exit_rules(
            [
                {"type": "moon_phase", "params": {}},
                {"type": "max_hold", "params": {"days": 20}},
            ]
        )


def test_build_exit_rules_missing_max_hold_raises() -> None:
    with pytest.raises(ValueError, match="max_hold"):
        build_exit_rules([{"type": "stop_loss", "params": {"pct": 0.08}}])


def test_build_exit_rules_duplicate_type_raises() -> None:
    with pytest.raises(ValueError, match="重复"):
        build_exit_rules(
            [
                {"type": "max_hold", "params": {"days": 10}},
                {"type": "max_hold", "params": {"days": 20}},
            ]
        )


def test_build_exit_rules_params_out_of_range_raises() -> None:
    """各 Rule __init__ 范围校验透传（period 越界 → ValueError，禁夹取）。"""

    with pytest.raises(ValueError):
        build_exit_rules(
            [
                {"type": "ma_break", "params": {"period": 999}},  # > 250
                {"type": "max_hold", "params": {"days": 20}},
            ]
        )


def test_build_exit_rules_stop_loss_pct_sign_convention() -> None:
    """stop_loss 存正数 pct=0.08 → StopLossRule(threshold=-0.08)（符号约定）。"""

    rule, _ = build_exit_rules(
        [
            {"type": "stop_loss", "params": {"pct": 0.08}},
            {"type": "max_hold", "params": {"days": 20}},
        ]
    )
    # 用一个穿透 -8% 的序列验证止损按 -0.08 触发
    rows = [
        {"trade_date": "20240102", "close": 10.0, "low": 9.95, "high": 10.0},
        {"trade_date": "20240103", "close": 9.5, "low": 9.0, "high": 9.6},  # low 9.0 < 9.2
    ]
    quotes = _build_quotes(rows)
    out = simulate_exit(
        buy_date="20240102", ts_code="X", prices_df=quotes, rules=rule, ma_window=None
    )
    assert out is not None
    assert out.exit_reason == "stop_loss"


# ----------------------------------------------------------------------
# 回归等价测（最关键）：build_exit_rules(default_exit) ≡ default_rules()
# ----------------------------------------------------------------------

_DEFAULT_EXIT_RULES = [
    {"type": "stop_loss", "params": {"pct": 0.08}},
    {"type": "ma_break", "params": {"period": 5}},
    {"type": "max_hold", "params": {"days": 20}},
]


def _regression_quote_panels() -> list[pd.DataFrame]:
    """覆盖四条出场路径的固定输入序列集合。"""

    panels: list[pd.DataFrame] = []

    # 1) MA5 跌破
    panels.append(
        _build_quotes(
            [
                {"trade_date": "20240102", "close": 10.0, "low": 9.8, "high": 10.1},
                {"trade_date": "20240103", "close": 10.2, "low": 10.0, "high": 10.3},
                {"trade_date": "20240104", "close": 10.4, "low": 10.2, "high": 10.5},
                {"trade_date": "20240105", "close": 10.6, "low": 10.4, "high": 10.7},
                {"trade_date": "20240108", "close": 10.8, "low": 10.6, "high": 10.9},
                {"trade_date": "20240109", "close": 11.0, "low": 10.8, "high": 11.1},
                {"trade_date": "20240110", "close": 10.2, "low": 10.0, "high": 10.3},
            ]
        )
    )
    # 2) 止损穿透
    panels.append(
        _build_quotes(
            [
                {"trade_date": "20240102", "close": 10.0, "low": 9.9, "high": 10.0},
                {"trade_date": "20240103", "close": 9.5, "low": 9.0, "high": 9.6},
            ]
        )
    )
    # 3) max_hold（连涨 25 日）
    dates = pd.bdate_range("2024-01-02", periods=25).strftime("%Y%m%d").tolist()
    panels.append(
        _build_quotes(
            [
                {"trade_date": d, "close": 10.0 + 0.01 * i,
                 "low": 9.99 + 0.01 * i, "high": 10.01 + 0.01 * i}
                for i, d in enumerate(dates)
            ]
        )
    )
    # 4) force_close（数据末尾兜底，平缓上行不触发任何规则）
    panels.append(
        _build_quotes(
            [
                {"trade_date": "20240102", "close": 10.0, "low": 9.9, "high": 10.05},
                {"trade_date": "20240103", "close": 10.05, "low": 9.95, "high": 10.1},
                {"trade_date": "20240104", "close": 10.10, "low": 10.0, "high": 10.15},
            ]
        )
    )
    return panels


@pytest.mark.parametrize("panel_idx", range(4))
def test_build_exit_rules_default_equivalent_to_default_rules(panel_idx: int) -> None:
    """**回归等价测**：build_exit_rules(default_exit.exit_rules) 与 default_rules()
    对同一输入，simulate_exit 结果 value/exit_reason/hold_days/exit_date 逐行相等。
    """

    panel = _regression_quote_panels()[panel_idx]
    buy_date = str(panel.iloc[0]["trade_date"])

    rule_built, ma_window = build_exit_rules(_DEFAULT_EXIT_RULES)
    assert ma_window == MA_WINDOW  # default_exit 的 ma_break period=5

    out_built = simulate_exit(
        buy_date=buy_date, ts_code="X", prices_df=panel,
        rules=rule_built, ma_window=ma_window,
    )
    out_default = simulate_exit(
        buy_date=buy_date, ts_code="X", prices_df=panel,
        rules=default_rules(), ma_window=MA_WINDOW,
    )

    assert (out_built is None) == (out_default is None)
    if out_built is not None and out_default is not None:
        assert out_built.exit_reason == out_default.exit_reason
        assert out_built.exit_date == out_default.exit_date
        assert out_built.hold_days == out_default.hold_days
        assert out_built.exit_price == pytest.approx(out_default.exit_price)


def test_build_exit_rules_default_equivalent_no_high_column() -> None:
    """default_exit 规则不读 high → 即便 prices_df 缺 high 列，两路径仍逐行相等。

    守 _normalize_prices 对缺 high 的兜底（high=close）不影响 default 输出。
    """

    panel = _build_quotes(
        [
            {"trade_date": "20240102", "close": 10.0, "low": 9.8},
            {"trade_date": "20240103", "close": 10.2, "low": 10.0},
            {"trade_date": "20240104", "close": 10.4, "low": 10.2},
            {"trade_date": "20240105", "close": 10.6, "low": 10.4},
            {"trade_date": "20240108", "close": 10.8, "low": 10.6},
            {"trade_date": "20240109", "close": 11.0, "low": 10.8},
            {"trade_date": "20240110", "close": 10.2, "low": 10.0},
        ]
    )
    rule_built, ma_window = build_exit_rules(_DEFAULT_EXIT_RULES)
    out_built = simulate_exit(
        buy_date="20240102", ts_code="X", prices_df=panel,
        rules=rule_built, ma_window=ma_window,
    )
    out_default = simulate_exit(
        buy_date="20240102", ts_code="X", prices_df=panel,
        rules=default_rules(), ma_window=MA_WINDOW,
    )
    assert out_built is not None and out_default is not None
    assert out_built.exit_reason == out_default.exit_reason
    assert out_built.exit_date == out_default.exit_date
    assert out_built.exit_price == pytest.approx(out_default.exit_price)
    assert out_built.hold_days == out_default.hold_days


# ----------------------------------------------------------------------
# 窗口无关 MA（约束 1 / bug4）：MA(t) 须只依赖窗口内 w 个 close、与序列起点无关
# ----------------------------------------------------------------------

def test_ensure_ma_is_window_start_invariant_bit_stable() -> None:
    """约束 1 / bug4：_ensure_ma 的 MA(t) 必须**逐位**(==, 非 approx)只依赖窗口内的
    w 个 close、与序列起点无关——同一日期在「整段」与「尾段」两个加载窗口下 MA 相等。

    旧 `rolling().mean()` 用滑动累加（running sum 加新减旧），MA(t) 的浮点末位依赖
    rolling 序列起点到 t 的整条累加路径 → 增量 chunk(g0_load 起) 与整段重算(start 起)
    在同一 (ts_code,t) 上可差 1 ULP、close≈ma 时翻转 ma_break。本测试用混入早期大值的
    序列放大累加差异：尾段从大值之后起算（不含大值），整段含大值；新实现(逐窗独立求和)
    两者重叠区逐位一致，旧实现(滑动累加)早期大值残差污染整段 running sum → 不一致。
    """

    dates = pd.bdate_range("2024-01-02", periods=80).strftime("%Y%m%d").tolist()
    closes = [10.0 + ((i * 37) % 13) * 0.0123456789 for i in range(80)]
    closes[0] = 1.0e8  # 早期大值：滑动累加的残差会污染其后整条 running sum
    full = pd.DataFrame({"trade_date": dates, "close": closes})
    tail = pd.DataFrame({"trade_date": dates[40:], "close": closes[40:]})

    ma_full = _ensure_ma(full, 5).set_index("trade_date")["ma"]
    ma_tail = _ensure_ma(tail, 5).set_index("trade_date")["ma"]

    overlap = dates[44:]  # 尾段前 4 行因 min_periods 为 NaN，dates[44] 起非 NaN
    mismatches = [
        (d, ma_full[d], ma_tail[d]) for d in overlap if ma_full[d] != ma_tail[d]
    ]
    assert not mismatches, f"窗口起点导致 MA 不一致(违反约束 1): {mismatches[:3]}"

    # NaN 边界：尾段前 ma_window-1 行必须为 NaN（等价 min_periods=window）。
    assert ma_tail[dates[40:44]].isna().all()
