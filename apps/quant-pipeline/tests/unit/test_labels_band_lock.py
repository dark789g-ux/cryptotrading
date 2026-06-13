"""labels/band_lock_labels.py 单测（trailing-lock-exit-design spec 03 §二）。

覆盖 band_lock 独立有状态 scheme 的标签产出：方案一/二、锁定后 MA5 离场、
停牌跳过、封死跌停顺延、max_hold 兜底、no_exit→force_close 收口，以及
base_scheme_codec 的 band_lock 编码。不连 DB / 不依赖 lightgbm / torch（纯 pandas）。

口径要点（与 strategy_aware 的差异，仅本 scheme）：
  - 买入价 = T+1 hfq open_adj（非 close_adj）。
  - signal_high = 信号日 T hfq high_adj。
  - 共享核 simulate_band_lock 已有 21 单测锁住行为，本测聚焦"标签层装配 + 落库
    口径（value/exit_reason/hold_days/scheme）"是否正确，不重复核内逐 bar 断言。
"""

from __future__ import annotations

import math

import pandas as pd
import pytest

from quant_pipeline.labels.band_lock_labels import (
    BAND_LOCK_SCHEME,
    compute_band_lock_labels,
)
from quant_pipeline.labels.dir3_scheme import base_scheme_codec
from quant_pipeline.labels.strategy_aware import LabelInputs


def _quotes(rows: list[dict]) -> pd.DataFrame:
    """构造 band_lock 所需 quotes：hfq open/high/low/close + raw open/high。

    rows 每项给 trade_date + raw open/high/low/close；本助手默认 adj_factor=1 →
    hfq == raw（测试聚焦标签装配，复权倍数不影响相对收益与触发逻辑）。
    可在 row 里显式给 close_adj/open_adj/... 覆盖（如测复权倍数）。
    """

    df = pd.DataFrame(rows)
    df["ts_code"] = df.get("ts_code", "X")
    for raw_col, adj_col in (
        ("open", "open_adj"),
        ("high", "high_adj"),
        ("low", "low_adj"),
        ("close", "close_adj"),
    ):
        if adj_col not in df.columns:
            df[adj_col] = df[raw_col]
    return df


def _entries(signal_date: str, ts_code: str = "X") -> pd.DataFrame:
    return pd.DataFrame({"ts_code": [ts_code], "trade_date": [signal_date]})


# ----------------------------------------------------------------------
# 方案一：跟踪止损出场（spec 01 §七最小可复算例 S1）
# ----------------------------------------------------------------------

def test_scheme1_tracking_stop_exit() -> None:
    """方案一：T+1 close>open；T+2 锁定；T+3 触跟踪止损 → reason=stop, scheme 落库。

    signal_high=10.0；T+1(o10,l9.8,c10.2→方案一,cost=10)；stop_next=floor2(9.99)=9.99。
    T+2(l10.5,h10.6,c10.5)>signal_high → 锁定 stop_next=floor2(10.4895)=10.48。
    T+3(l10.40)≤10.48 → 触发，非封死跌停 → exit@min(10.48, open(T+3)=10.45)=10.45。
    value = 10.45/10.0 - 1 = 0.045；hold_days=2；exit_reason 共享核给 'stop'。
    """

    quotes = _quotes(
        [
            # 信号日 T：signal_high = high_adj = 10.0
            {"trade_date": "20240101", "open": 9.9, "high": 10.0, "low": 9.7, "close": 9.95},
            # T+1 持仓首日
            {"trade_date": "20240102", "open": 10.0, "high": 10.3, "low": 9.8, "close": 10.2},
            # T+2 锁定日
            {"trade_date": "20240103", "open": 10.4, "high": 10.6, "low": 10.5, "close": 10.5},
            # T+3 触止损
            {"trade_date": "20240104", "open": 10.45, "high": 10.5, "low": 10.40, "close": 10.42},
            {"trade_date": "20240105", "open": 10.4, "high": 10.5, "low": 10.3, "close": 10.4},
        ]
    )
    out = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240105")
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["trade_date"] == "20240101"
    assert row["scheme"] == BAND_LOCK_SCHEME
    assert row["exit_reason"] == "stop"
    assert row["hold_days"] == 2
    # exit@min(10.48, open(T+3)=10.45)=10.45 → value = 10.45/10.0 - 1
    assert math.isclose(row["value"], 10.45 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 方案二：初始止损 = low(T+1)×0.999
# ----------------------------------------------------------------------

def test_scheme2_initial_stop_from_low() -> None:
    """方案二：T+1 close<=open → 初始止损 floor2(low(T+1)×0.999)；T+2 触发。

    T+1(o10,l9.7,c9.9→方案二,cost=10)；stop_next(给T+2)=floor2(9.7×0.999)=floor2(9.6903)=9.69。
    T+2(l9.5)≤9.69 → 触发，open(T+2)=9.6 < 9.69 → 跳空低开 → exit@min(9.69,9.6)=9.6。
    value = 9.6/10.0 - 1 = -0.04；hold_days=1。
    """

    quotes = _quotes(
        [
            {"trade_date": "20240101", "open": 9.8, "high": 10.0, "low": 9.6, "close": 9.9},
            {"trade_date": "20240102", "open": 10.0, "high": 10.1, "low": 9.7, "close": 9.9},
            {"trade_date": "20240103", "open": 9.6, "high": 9.7, "low": 9.5, "close": 9.55},
            {"trade_date": "20240104", "open": 9.5, "high": 9.6, "low": 9.4, "close": 9.5},
        ]
    )
    out = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240104")
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "stop"
    assert row["hold_days"] == 1
    assert math.isclose(row["value"], 9.6 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 锁定后 MA5 收盘离场
# ----------------------------------------------------------------------

def test_locked_then_ma5_exit() -> None:
    """锁定后某日 close<ma5 且 ma5<prev_ma5 → reason=ma5_exit, exit@adj_close。

    构造（数值经共享核实跑验证）：
      - 前 4 根预热 MA5；信号日 T=20240104（high=10.0 → signal_high=10.0）。
      - T+1=20240105 open=10.0、close=10.8>open → 方案一，初始止损 floor2(9.99)=9.99。
      - T+2=20240106 low=10.7>signal_high → 锁定，冻结止损 floor2(10.6893)=10.68。
      - 此后 low 始终 >10.68（不触止损），MA5 在 20240110 拐头向下且收盘跌破
        （close 10.75 < ma5 11.02 < prev_ma5 11.03）→ ma5_exit @adj_close=10.75。
    value = 10.75/10.0 - 1 = 0.075；hold_days=5（T+2..T+6）。
    """

    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 10.2, "low": 9.9, "close": 10.0},
        {"trade_date": "20240102", "open": 10.1, "high": 10.3, "low": 10.0, "close": 10.2},
        {"trade_date": "20240103", "open": 10.3, "high": 10.5, "low": 10.2, "close": 10.4},
        {"trade_date": "20240104", "open": 9.9, "high": 10.0, "low": 9.8, "close": 10.0},
        {"trade_date": "20240105", "open": 10.0, "high": 10.9, "low": 9.95, "close": 10.8},
        {"trade_date": "20240106", "open": 10.9, "high": 11.3, "low": 10.7, "close": 11.2},
        {"trade_date": "20240107", "open": 11.2, "high": 11.4, "low": 11.0, "close": 11.3},
        {"trade_date": "20240108", "open": 11.1, "high": 11.2, "low": 10.9, "close": 11.0},
        {"trade_date": "20240109", "open": 10.9, "high": 11.0, "low": 10.75, "close": 10.85},
        {"trade_date": "20240110", "open": 10.85, "high": 10.9, "low": 10.7, "close": 10.75},
        {"trade_date": "20240111", "open": 10.75, "high": 10.8, "low": 10.7, "close": 10.72},
    ]
    quotes = _quotes(rows)
    out = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240104"), end="20240111")
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "ma5_exit"
    assert row["hold_days"] == 5
    # ma5_exit 出场价 = 触发日 adj_close=10.75；buy_price=open(T+1)=10.0
    assert math.isclose(row["value"], 10.75 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 停牌日跳过（A 股停牌缺行 + 冗余 suspend_d）
# ----------------------------------------------------------------------

def test_suspended_day_skipped() -> None:
    """持仓期某日在 suspend_d → 该日不计 hold、不触发；出场 hold_days 不含停牌日。

    用 suspend_d 标记 T+2 停牌（即便有行也按停牌处理），止损在 T+3 才触发。
    """

    quotes = _quotes(
        [
            {"trade_date": "20240101", "open": 9.9, "high": 10.0, "low": 9.7, "close": 9.95},
            {"trade_date": "20240102", "open": 10.0, "high": 10.1, "low": 9.95, "close": 10.05},
            # T+2 停牌（suspend_d 标记）
            {"trade_date": "20240103", "open": 10.0, "high": 10.1, "low": 9.0, "close": 9.5},
            # T+3 真正触止损（stop_next=floor2(10.0×0.999)=9.99；low 9.0≤9.99）
            {"trade_date": "20240104", "open": 9.8, "high": 9.9, "low": 9.0, "close": 9.5},
            {"trade_date": "20240105", "open": 9.5, "high": 9.6, "low": 9.4, "close": 9.5},
        ]
    )
    suspend = pd.DataFrame({"ts_code": ["X"], "trade_date": ["20240103"]})
    out = compute_band_lock_labels(
        LabelInputs(
            daily_quotes=quotes,
            suspend_d=suspend,
            entries=_entries("20240101"),
            end="20240105",
        )
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "stop"
    # T+2 停牌不计 hold → T+3 触发时 hold_days=1（只数 T+1、T+3 中的可交易日）
    assert row["hold_days"] == 1


# ----------------------------------------------------------------------
# 封死跌停顺延（raw_high ≤ down_limit）
# ----------------------------------------------------------------------

def test_dead_limit_down_defers_exit() -> None:
    """止损触发日封死跌停（raw_high≤down_limit）→ 顺延到次日 @adj_open，reason 保留。"""

    quotes = _quotes(
        [
            {"trade_date": "20240101", "open": 9.9, "high": 10.0, "low": 9.7, "close": 9.95},
            {"trade_date": "20240102", "open": 10.0, "high": 10.1, "low": 9.95, "close": 10.05},
            # T+2 止损触发(low 9.0≤stop9.99) 且封死跌停(high 9.2≤down_limit 9.2)
            {"trade_date": "20240103", "open": 9.2, "high": 9.2, "low": 9.0, "close": 9.0},
            # T+3 非封死跌停 → 顺延出场 @adj_open=9.3
            {"trade_date": "20240104", "open": 9.3, "high": 9.5, "low": 9.1, "close": 9.4},
        ]
    )
    stk_limit = pd.DataFrame(
        [
            {"ts_code": "X", "trade_date": "20240103", "up_limit": 11.0, "down_limit": 9.2},
            {"ts_code": "X", "trade_date": "20240104", "up_limit": 10.5, "down_limit": 8.4},
        ]
    )
    out = compute_band_lock_labels(
        LabelInputs(
            daily_quotes=quotes,
            stk_limit=stk_limit,
            entries=_entries("20240101"),
            end="20240104",
        )
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "stop"
    # 顺延到 T+3 @adj_open=9.3；value=9.3/10.0-1
    assert math.isclose(row["value"], 9.3 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# max_hold 兜底
# ----------------------------------------------------------------------

def test_max_hold_caps_holding() -> None:
    """signal_high 设高位不锁定、全程不触止损 → max_hold=3 在第3持有日 @adj_close 平仓。"""

    # 信号日 high=20 → signal_high 极高（low 始终 < signal_high → 不锁定）；
    # 单调缓涨，low 不跌破跟踪止损 → max_hold=3 在第 3 持有日(20240105)平仓。
    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 20.0, "low": 9.9, "close": 9.95},
        {"trade_date": "20240102", "open": 10.0, "high": 10.2, "low": 9.99, "close": 10.1},
        {"trade_date": "20240103", "open": 10.1, "high": 10.3, "low": 10.05, "close": 10.2},
        {"trade_date": "20240104", "open": 10.2, "high": 10.4, "low": 10.15, "close": 10.3},
        {"trade_date": "20240105", "open": 10.3, "high": 10.5, "low": 10.25, "close": 10.4},
        {"trade_date": "20240106", "open": 10.4, "high": 10.6, "low": 10.35, "close": 10.5},
    ]
    quotes = _quotes(rows)
    out = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240106"),
        max_hold=3,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "max_hold"
    assert row["hold_days"] == 3
    # exit@adj_close(T+4=20240105)=10.4；buy=open(T+1)=10.0 → value=0.04
    assert math.isclose(row["value"], 10.4 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# no_exit → force_close 兜底
# ----------------------------------------------------------------------

def test_no_exit_force_close() -> None:
    """窗口耗尽未出场（无 max_hold、不触发任何条件）→ force_close @最后有效 adj_close。"""

    # 信号日 high=20 → 不锁定；缓涨不触止损；无 max_hold → 窗口耗尽 no_exit。
    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 20.0, "low": 9.9, "close": 9.95},
        {"trade_date": "20240102", "open": 10.0, "high": 10.2, "low": 9.99, "close": 10.1},
        {"trade_date": "20240103", "open": 10.1, "high": 10.3, "low": 10.05, "close": 10.2},
        {"trade_date": "20240104", "open": 10.2, "high": 10.4, "low": 10.15, "close": 10.3},
    ]
    quotes = _quotes(rows)
    out = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240104")
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "force_close"
    # 兜底取最后一个有效 adj_close=10.3；buy=10.0 → value=0.03；hold_days=2（T+2、T+3）
    assert row["hold_days"] == 2
    assert math.isclose(row["value"], 10.3 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 退市 force_close：窗口截断到退市日之前 → force_close 收口
# ----------------------------------------------------------------------

def test_delist_force_close() -> None:
    """退市股：窗口截到 delist_date 前，核耗尽返回 no_exit → force_close @退市前末日。

    delist_date=20240105；窗口仅含 < 20240105 的行（T+1=20240102、20240103、
    20240104），全程不触发任何条件 → force_close @最后有效 adj_close=10.3。
    """

    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 20.0, "low": 9.9, "close": 9.95},
        {"trade_date": "20240102", "open": 10.0, "high": 10.2, "low": 9.99, "close": 10.1},
        {"trade_date": "20240103", "open": 10.1, "high": 10.3, "low": 10.05, "close": 10.2},
        {"trade_date": "20240104", "open": 10.2, "high": 10.4, "low": 10.15, "close": 10.3},
        {"trade_date": "20240105", "open": 10.3, "high": 10.5, "low": 10.25, "close": 10.4},
    ]
    quotes = _quotes(rows)
    delist = pd.DataFrame({"ts_code": ["X"], "delist_date": ["20240105"]})
    out = compute_band_lock_labels(
        LabelInputs(
            daily_quotes=quotes,
            delist=delist,
            entries=_entries("20240101"),
            end="20240105",
        )
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "force_close"
    # 截断到 20240105 前 → 末日 20240104 adj_close=10.3；buy=10.0 → value=0.03
    assert math.isclose(row["value"], 10.3 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 入场过滤：一字涨停买不进 → 无标签
# ----------------------------------------------------------------------

def test_limit_up_on_entry_no_label() -> None:
    """T+1 一字涨停（raw_open≥up_limit）→ 该信号不产生标签（核 no_entry，标签层跳过）。

    derive_limit_up_set 用 raw close≥up_limit*(1-tol) 在 entries 阶段已先剔除；
    本测确保即便侥幸过了 entries 过滤，核 no_entry 也不会产出标签。
    """

    quotes = _quotes(
        [
            {"trade_date": "20240101", "open": 9.9, "high": 10.0, "low": 9.7, "close": 9.95},
            # T+1 open=11.0 == up_limit → 一字涨停
            {"trade_date": "20240102", "open": 11.0, "high": 11.0, "low": 11.0, "close": 11.0},
            {"trade_date": "20240103", "open": 11.0, "high": 11.2, "low": 10.9, "close": 11.1},
        ]
    )
    stk_limit = pd.DataFrame(
        [{"ts_code": "X", "trade_date": "20240102", "up_limit": 11.0, "down_limit": 8.9}]
    )
    out = compute_band_lock_labels(
        LabelInputs(
            daily_quotes=quotes,
            stk_limit=stk_limit,
            entries=_entries("20240101"),
            end="20240103",
        )
    )
    # entries 阶段 derive_limit_up_set 剔除 → 无候选 → 空表
    assert out.empty


# ----------------------------------------------------------------------
# base_scheme_codec：band_lock 编码
# ----------------------------------------------------------------------

def test_base_scheme_codec_band_lock() -> None:
    assert base_scheme_codec("band_lock", {}) == "band_lock"
    assert base_scheme_codec("band_lock", None) == "band_lock"
    assert base_scheme_codec("band_lock", {"max_hold": None}) == "band_lock"
    assert base_scheme_codec("band_lock", {"max_hold": 10}) == "band_lock__mh10"
    with pytest.raises(ValueError):
        base_scheme_codec("band_lock", {"max_hold": 0})
    with pytest.raises(ValueError):
        base_scheme_codec("band_lock", {"max_hold": True})


# ----------------------------------------------------------------------
# 出场参数透传到共享核（params-config-design spec 05 §一）
# ----------------------------------------------------------------------

def test_exit_params_default_zero_drift() -> None:
    """4 个出场参数全默认 → 与不传（现状）逐位一致（零漂移硬门）。

    同一份 quotes，一次走默认（无参数），一次显式传全默认值，两次结果须逐列相等。
    """

    quotes = _quotes(
        [
            {"trade_date": "20240101", "open": 9.9, "high": 10.0, "low": 9.7, "close": 9.95},
            {"trade_date": "20240102", "open": 10.0, "high": 10.3, "low": 9.8, "close": 10.2},
            {"trade_date": "20240103", "open": 10.4, "high": 10.6, "low": 10.5, "close": 10.5},
            {"trade_date": "20240104", "open": 10.45, "high": 10.5, "low": 10.40, "close": 10.42},
            {"trade_date": "20240105", "open": 10.4, "high": 10.5, "low": 10.3, "close": 10.4},
        ]
    )
    base = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240105")
    )
    explicit = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240105"),
        stop_ratio=0.999,
        floor_ratio=0.999,
        floor_enabled=True,
        ma5_require_down=True,
    )
    pd.testing.assert_frame_equal(base, explicit)


def test_stop_ratio_param_changes_exit_price() -> None:
    """收紧 stop_ratio（0.999→0.990）使止损基准更低 → 出场价随之变化（参数确实生效）。

    方案一：T+1 close>open，cost=10。stop_next(给T+2)=floor2(10×stop_ratio)。
      - stop_ratio=0.999 → floor2(9.99)=9.99；
      - stop_ratio=0.990 → floor2(9.90)=9.90。
    T+2 锁定后冻结的跟踪止损也随系数缩放，两次出场价不同 → 证明 stop_ratio 透传到核。
    """

    quotes = _quotes(
        [
            {"trade_date": "20240101", "open": 9.9, "high": 10.0, "low": 9.7, "close": 9.95},
            {"trade_date": "20240102", "open": 10.0, "high": 10.3, "low": 9.8, "close": 10.2},
            {"trade_date": "20240103", "open": 10.4, "high": 10.6, "low": 10.5, "close": 10.5},
            {"trade_date": "20240104", "open": 10.45, "high": 10.5, "low": 10.40, "close": 10.42},
            {"trade_date": "20240105", "open": 10.4, "high": 10.5, "low": 10.3, "close": 10.4},
        ]
    )
    tight = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240105"),
        stop_ratio=0.990,
    )
    loose = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240105"),
        stop_ratio=0.999,
    )
    assert len(tight) == 1 and len(loose) == 1
    # 两个 stop_ratio 给出不同结果（出场价 / 出场原因任一不同）→ 参数确实透传到核。
    assert (
        not math.isclose(tight.iloc[0]["value"], loose.iloc[0]["value"], rel_tol=1e-9)
        or tight.iloc[0]["exit_reason"] != loose.iloc[0]["exit_reason"]
        or tight.iloc[0]["hold_days"] != loose.iloc[0]["hold_days"]
    )


def test_floor_enabled_and_floor_ratio_passthrough() -> None:
    """floor_enabled / floor_ratio 透传到核：方案二锁盈地板抬高跟踪止损 → 出场不同。

    构造方案二入场（T+1 close<=open，cost=open(T+1)=10）、signal_high 极高（永不锁定，
    走未锁定跟踪止损 (2c)）。T+2 收盘>cost → floor_active；floor_ratio=1.02 →
    floor_price=floor2(10×1.02)=10.20，高于按 low×0.999 算的自然止损。
      - floor_enabled=True ：stop_next=max(low_stop, 10.20) → T+3 在 10.19 触止损（核实跑）。
      - floor_enabled=False：地板短路 → stop_next=low_stop → T+4 才在 10.08 触止损。
    （核侧数值由 simulate_band_lock 直接验证，本测确认标签层把两参数透传到核。）
    """

    # 信号日 T high=50 → signal_high 极高（永不锁定）；T+1..T+4 = 上面 4 根 bar。
    rows = [
        {"trade_date": "20240101", "open": 9.9, "high": 50.0, "low": 9.7, "close": 9.95},
        {"trade_date": "20240102", "open": 10.0, "high": 10.2, "low": 9.7, "close": 9.9},
        {"trade_date": "20240103", "open": 10.3, "high": 10.6, "low": 10.1, "close": 10.5},
        {"trade_date": "20240104", "open": 10.2, "high": 10.3, "low": 10.1, "close": 10.15},
        {"trade_date": "20240105", "open": 10.1, "high": 10.2, "low": 9.9, "close": 10.0},
    ]
    quotes = _quotes(rows)
    enabled = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240105"),
        floor_enabled=True,
        floor_ratio=1.02,
    )
    disabled = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240105"),
        floor_enabled=False,
        floor_ratio=1.02,
    )
    assert len(enabled) == 1 and len(disabled) == 1
    # buy_price = open(T+1)=10.0。
    # floor 启用：止损 @10.19、hold=2；短路：@10.08、hold=3。
    assert enabled.iloc[0]["exit_reason"] == "stop"
    assert disabled.iloc[0]["exit_reason"] == "stop"
    assert enabled.iloc[0]["hold_days"] == 2
    assert disabled.iloc[0]["hold_days"] == 3
    assert math.isclose(enabled.iloc[0]["value"], 10.19 / 10.0 - 1.0, rel_tol=1e-9)
    assert math.isclose(disabled.iloc[0]["value"], 10.08 / 10.0 - 1.0, rel_tol=1e-9)


def test_ma5_require_down_passthrough() -> None:
    """ma5_require_down=False 比 True 更敏感（只要收盘跌破 MA5 即离场）→ 结果可不同。

    复用 test_locked_then_ma5_exit 的锁定后场景，但 ma5_require_down=False 时不要求
    均线下行，可能在更早某日（close<ma5 但 ma5>=prev_ma5）就离场 → 与 True 路径不同。
    """

    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 10.2, "low": 9.9, "close": 10.0},
        {"trade_date": "20240102", "open": 10.1, "high": 10.3, "low": 10.0, "close": 10.2},
        {"trade_date": "20240103", "open": 10.3, "high": 10.5, "low": 10.2, "close": 10.4},
        {"trade_date": "20240104", "open": 9.9, "high": 10.0, "low": 9.8, "close": 10.0},
        {"trade_date": "20240105", "open": 10.0, "high": 10.9, "low": 9.95, "close": 10.8},
        {"trade_date": "20240106", "open": 10.9, "high": 11.3, "low": 10.7, "close": 11.2},
        {"trade_date": "20240107", "open": 11.2, "high": 11.4, "low": 11.0, "close": 11.3},
        {"trade_date": "20240108", "open": 11.1, "high": 11.2, "low": 10.9, "close": 11.0},
        {"trade_date": "20240109", "open": 10.9, "high": 11.0, "low": 10.75, "close": 10.85},
        {"trade_date": "20240110", "open": 10.85, "high": 10.9, "low": 10.7, "close": 10.75},
        {"trade_date": "20240111", "open": 10.75, "high": 10.8, "low": 10.7, "close": 10.72},
    ]
    quotes = _quotes(rows)
    require_down = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240104"), end="20240111"),
        ma5_require_down=True,
    )
    sensitive = compute_band_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240104"), end="20240111"),
        ma5_require_down=False,
    )
    assert len(require_down) == 1 and len(sensitive) == 1
    assert require_down.iloc[0]["exit_reason"] == "ma5_exit"
    assert sensitive.iloc[0]["exit_reason"] == "ma5_exit"
    # 更敏感（不要求均线下行）→ 不晚于 require_down 离场（hold_days <=），且本数据严格更早。
    assert sensitive.iloc[0]["hold_days"] < require_down.iloc[0]["hold_days"]
