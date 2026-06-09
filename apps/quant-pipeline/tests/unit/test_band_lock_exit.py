"""strategy/band_lock_exit.py 单测 —— 波段跟踪止损 trailing_lock 对拍样例 S1~S13。

本测试是跨语言对拍（Python 核 vs 同构 TS 版）的 Python 侧期望表，逐条对
docs/superpowers/specs/2026-06-09-trailing-lock-exit-design/02 §四 的样例做**精确数值断言**
（含 kind/reason/exit_index/exit_price/scheme/hold_days），任何偏差都会让对拍失败。

样例覆盖：
  S1  方案一·跟踪止损出场（精确数值）
  S2  方案一·锁定后 MA5 离场
  S3  方案二·初始止损 = low×0.999（精确数值）
  S4  方案二·保本地板（未锁定，浮盈后 max(low×0.999, cost×0.999)）—— 用次日 low 探针锁死止损价
  S5  跳空低开 → exit_price = open（min 取开盘）
  S6  封死跌停顺延 → 次日非封死 @adj_open，reason 保留
  S7  停牌跳过 → 不计 hold、不触发、不更新止损
  S8  一字涨停买不进 → no_entry / limit_up
  S9  持仓首日不自止损（初始止损 T+2 才生效）
  S10 MA5 预热不足（ma5=None）→ 不触发 MA5 离场，仅止损逻辑
  S11 max_hold 兜底（精确 exit_index/hold_days）
  S12 窗口耗尽未出场 → no_exit
  S13 方案二·保本地板锁定当日首次浮盈（验 P3：(2-pre) 先激活地板）—— 探针锁死冻结止损价
外加 floor2 取整边界单测。
"""

from __future__ import annotations

from quant_pipeline.strategy.band_lock_exit import (
    BandLockBar,
    BandLockOutcome,
    floor2,
    simulate_band_lock,
)


def _bar(
    o: float | None = None,
    h: float | None = None,
    low: float | None = None,
    c: float | None = None,
    ma5: float | None = None,
    *,
    ro: float | None = None,
    rh: float | None = None,
    up: float | None = None,
    dn: float | None = None,
    sus: bool = False,
) -> BandLockBar:
    """测试构造助手。

    未给 raw_open/raw_high 时默认等于复权 open/high（不触发限停板，避免误触）；
    未给 up/down_limit 时默认 None（该端约束不生效）。
    """

    return BandLockBar(
        adj_open=o,
        adj_high=h,
        adj_low=low,
        adj_close=c,
        ma5=ma5,
        raw_open=o if ro is None else ro,
        raw_high=h if rh is None else rh,
        up_limit=up,
        down_limit=dn,
        is_suspended=sus,
    )


# ----------------------------------------------------------------------
# floor2 取整边界（跨语言逐位一致）
# ----------------------------------------------------------------------

def test_floor2_boundaries() -> None:
    assert floor2(9.99) == 9.99
    assert floor2(10.4895) == 10.48
    # 10.567 × 0.999 = 10.556433 → floor2 = 10.55
    assert floor2(10.567 * 0.999) == 10.55
    # 方案一初始止损边界：10.0 × 0.999 = 9.99
    assert floor2(10.0 * 0.999) == 9.99
    # 方案二初始止损边界：9.7 × 0.999 = 9.6903 → 9.69
    assert floor2(9.7 * 0.999) == 9.69
    # 锁定止损边界：10.5 × 0.999 = 10.4895 → 10.48
    assert floor2(10.5 * 0.999) == 10.48


# ----------------------------------------------------------------------
# S1：方案一·跟踪止损出场（精确数值）
# ----------------------------------------------------------------------

def test_s1_scheme1_trailing_stop() -> None:
    """signal_high=10.00；
    T+1(o10,l9.8,c10.2)→方案一，初始止损 floor2(10×0.999)=9.99；
    T+2(l10.5,h10.6,c10.5)→low>signal_high 锁定，stop_next=floor2(10.4895)=10.48；
    T+3(l10.40)≤10.48 触发 → stop @min(10.48, open(T+3)=10.45)=10.45。
    """

    bars = [
        _bar(o=10.0, h=10.3, low=9.8, c=10.2),
        _bar(o=10.4, h=10.6, low=10.5, c=10.5),
        _bar(o=10.45, h=10.5, low=10.40, c=10.42),
    ]
    out = simulate_band_lock(bars, 10.00)
    assert out == BandLockOutcome(
        kind="exit",
        reason="stop",
        exit_index=2,
        exit_price=10.45,
        scheme=1,
        hold_days=2,
    )


# ----------------------------------------------------------------------
# S2：方案一·锁定后 MA5 离场
# ----------------------------------------------------------------------

def test_s2_scheme1_ma5_exit() -> None:
    """锁定后某日 close<ma5 且 ma5<prev_ma5、且未先触止损 → ma5_exit @adj_close。

    T+1(o10,l9.8,c10.2,ma5=10.0)→方案一；prev_ma5=10.0。
    T+2(l10.5,c10.5,ma5=10.3)→锁定 stop_next=10.48；close 10.5≥ma5 不离场；prev_ma5→10.3。
    T+3(l10.5>10.48 不止损, c10.1<ma5=10.2 且 ma5 10.2<prev_ma5 10.3)→ma5_exit @10.1。
    """

    bars = [
        _bar(o=10.0, h=10.3, low=9.8, c=10.2, ma5=10.0),
        _bar(o=10.4, h=10.6, low=10.5, c=10.5, ma5=10.3),
        _bar(o=10.5, h=10.6, low=10.5, c=10.1, ma5=10.2),
    ]
    out = simulate_band_lock(bars, 10.00)
    assert out == BandLockOutcome(
        kind="exit",
        reason="ma5_exit",
        exit_index=2,
        exit_price=10.1,
        scheme=1,
        hold_days=2,
    )


# ----------------------------------------------------------------------
# S3：方案二·初始止损 = low×0.999（精确数值）
# ----------------------------------------------------------------------

def test_s3_scheme2_initial_stop() -> None:
    """signal_high=99（不锁定）；
    T+1(o10,l9.7,c9.9)→方案二（close≤open），stop_next=floor2(9.7×0.999)=9.69；
    T+2 low 9.60≤9.69 触发 → stop @min(9.69, open(T+2)=9.8)=9.69。
    """

    bars = [
        _bar(o=10.0, h=10.0, low=9.7, c=9.9),
        _bar(o=9.8, h=9.85, low=9.60, c=9.7),
    ]
    out = simulate_band_lock(bars, 99.0)
    assert out == BandLockOutcome(
        kind="exit",
        reason="stop",
        exit_index=1,
        exit_price=9.69,
        scheme=2,
        hold_days=1,
    )


# ----------------------------------------------------------------------
# S4：方案二·保本地板（未锁定，浮盈后 stop=max(low×0.999, cost×0.999)）
#   用次日 low 探针锁死止损价 = floor2(cost×0.999)=9.99。
# ----------------------------------------------------------------------

def test_s4_scheme2_breakeven_floor_triggers() -> None:
    """cost=10，floor=floor2(10×0.999)=9.99。signal_high=99 不锁定。
    T+1(o10,l9.7,c9.9)→方案二，init stop=9.69。
    T+2(l9.8,c10.2)→close>cost 激活地板；未锁定 stop_next=max(floor2(9.8×0.999)=9.79, 9.99)=9.99。
    T+3 low 9.98≤9.99 → stop @min(9.99, open 10.0)=9.99（证明地板把止损抬到 9.99）。
    """

    bars = [
        _bar(o=10.0, h=10.0, low=9.7, c=9.9),
        _bar(o=10.1, h=10.3, low=9.8, c=10.2),
        _bar(o=10.0, h=10.05, low=9.98, c=9.99),
    ]
    out = simulate_band_lock(bars, 99.0)
    assert out == BandLockOutcome(
        kind="exit",
        reason="stop",
        exit_index=2,
        exit_price=9.99,
        scheme=2,
        hold_days=2,
    )


def test_s4_scheme2_breakeven_floor_not_triggered_above() -> None:
    """同 S4 构造，但 T+3 low 10.00 > 地板 9.99 → 不触发，窗口耗尽 no_exit。

    与 test_s4_...triggers 成对，锁死「止损价恰为 9.99」：9.98 触发 / 10.00 不触发。
    """

    bars = [
        _bar(o=10.0, h=10.0, low=9.7, c=9.9),
        _bar(o=10.1, h=10.3, low=9.8, c=10.2),
        _bar(o=10.0, h=10.1, low=10.00, c=10.05),
    ]
    out = simulate_band_lock(bars, 99.0)
    assert out == BandLockOutcome(kind="no_exit")


# ----------------------------------------------------------------------
# S5：跳空低开 → exit_price = open（min 取开盘）
# ----------------------------------------------------------------------

def test_s5_gap_down_fills_at_open() -> None:
    """触发日 open 10.0 < stop_eff 10.48 → exit @min(10.48, 10.0)=10.0。

    T+1(o10,l9.8,c10.2)→方案一 init 9.99；T+2 锁定 stop_next=10.48；
    T+3 跳空低开 open10.0、low9.9≤10.48 触发 → 按开盘 10.0 成交。
    """

    bars = [
        _bar(o=10.0, h=10.3, low=9.8, c=10.2),
        _bar(o=10.4, h=10.6, low=10.5, c=10.5),
        _bar(o=10.0, h=10.05, low=9.9, c=9.95),
    ]
    out = simulate_band_lock(bars, 10.00)
    assert out == BandLockOutcome(
        kind="exit",
        reason="stop",
        exit_index=2,
        exit_price=10.0,
        scheme=1,
        hold_days=2,
    )


# ----------------------------------------------------------------------
# S6：封死跌停顺延 → 次日非封死 @adj_open，reason 保留
# ----------------------------------------------------------------------

def test_s6_dead_limit_down_defers_to_next_day() -> None:
    """止损触发日封死跌停（raw_high≤down_limit）→ pending='stop' 顺延；
    次日非封死 → 出场 @adj_open(次日)，reason 保留 'stop'。

    T+1/T+2 同 S1（锁定 stop_next=10.48）；
    T+3 low10.40≤10.48 触发，但 raw_high10.5≤down_limit10.5（封死）→ 顺延；
    T+4 非封死 → exit @adj_open(T+4)=10.2，exit_index=3，hold_days=3。
    """

    bars = [
        _bar(o=10.0, h=10.3, low=9.8, c=10.2),
        _bar(o=10.4, h=10.6, low=10.5, c=10.5),
        _bar(o=10.45, h=10.5, low=10.40, c=10.42, rh=10.5, dn=10.5),  # 封死跌停
        _bar(o=10.2, h=10.3, low=10.1, c=10.2),  # 次日非封死
    ]
    out = simulate_band_lock(bars, 10.00)
    assert out == BandLockOutcome(
        kind="exit",
        reason="stop",
        exit_index=3,
        exit_price=10.2,
        scheme=1,
        hold_days=3,
    )


# ----------------------------------------------------------------------
# S7：停牌跳过 → 不计 hold、不触发、不更新止损
# ----------------------------------------------------------------------

def test_s7_suspended_day_skipped() -> None:
    """持仓中某日 adj_close=None（停牌）→ 该日不计 hold、不触发、不更新止损。

    T+1(o10,l9.8,c10.2) init 9.99；T+2 停牌（全 None）跳过；
    T+3 锁定 stop_next=10.48；T+4 low10.40≤10.48 触发 → stop。
    hold_days=2（停牌日不计），exit_index=3。
    """

    bars = [
        _bar(o=10.0, h=10.3, low=9.8, c=10.2),
        _bar(),  # 停牌：adj_* 全 None
        _bar(o=10.4, h=10.6, low=10.5, c=10.5),
        _bar(o=10.45, h=10.5, low=10.40, c=10.42),
    ]
    out = simulate_band_lock(bars, 10.00)
    assert out == BandLockOutcome(
        kind="exit",
        reason="stop",
        exit_index=3,
        exit_price=10.45,
        scheme=1,
        hold_days=2,
    )


def test_s7_suspended_via_is_suspended_flag() -> None:
    """冗余防御：is_suspended=True 但价格非 None 也按停牌跳过（与 adj_close=None 等价）。"""

    bars = [
        _bar(o=10.0, h=10.3, low=9.8, c=10.2),
        _bar(o=10.4, h=10.6, low=10.5, c=10.5, sus=True),  # 标记停牌（但有价）
        _bar(o=10.4, h=10.6, low=10.5, c=10.5),  # 真正的锁定日
        _bar(o=10.45, h=10.5, low=10.40, c=10.42),
    ]
    out = simulate_band_lock(bars, 10.00)
    assert out.kind == "exit"
    assert out.reason == "stop"
    assert out.exit_index == 3
    assert out.hold_days == 2  # 停牌日不计


# ----------------------------------------------------------------------
# S8：一字涨停买不进 → no_entry / limit_up
# ----------------------------------------------------------------------

def test_s8_limit_up_no_entry() -> None:
    """T+1 raw_open ≥ up_limit → 买不进，no_entry(reason='limit_up')。"""

    bars = [_bar(o=10.0, h=10.0, low=10.0, c=10.0, ro=10.0, up=10.0)]
    out = simulate_band_lock(bars, 99.0)
    assert out == BandLockOutcome(kind="no_entry", reason="limit_up")


def test_s8_limit_up_strict_below_does_enter() -> None:
    """raw_open < up_limit（未顶格）→ 可买入，不判 limit_up。"""

    bars = [_bar(o=9.99, h=10.0, low=9.9, c=9.95, ro=9.99, up=10.0)]
    out = simulate_band_lock(bars, 99.0)
    # 单根窗口、未触发任何出场 → no_exit（证明入场成立）
    assert out.kind == "no_exit"


# ----------------------------------------------------------------------
# S8b：入场停牌 → no_entry / suspended
# ----------------------------------------------------------------------

def test_entry_suspended_no_entry() -> None:
    """T+1 停牌（adj_open/adj_close 为 None）→ no_entry(reason='suspended')。"""

    bars = [_bar()]  # 全 None
    out = simulate_band_lock(bars, 99.0)
    assert out == BandLockOutcome(kind="no_entry", reason="suspended")


# ----------------------------------------------------------------------
# S9：持仓首日不自止损（初始止损 T+2 才生效）
# ----------------------------------------------------------------------

def test_s9_entry_day_never_self_stops() -> None:
    """T+1 当天 low(8.0) 远低于 open×0.999(9.99)，但持仓首日不评估止损。

    单根窗口 → no_exit（持仓首日不出场，证明初始止损 T+2 才生效）。
    """

    bars = [_bar(o=10.0, h=10.2, low=8.0, c=10.1)]
    out = simulate_band_lock(bars, 99.0)
    assert out == BandLockOutcome(kind="no_exit")


# ----------------------------------------------------------------------
# S10：MA5 预热不足（ma5=None）→ 不触发 MA5 离场，仅止损逻辑
# ----------------------------------------------------------------------

def test_s10_ma5_warmup_none_no_ma5_exit() -> None:
    """锁定后 ma5=None → (2b) 因 ma5 守卫跳过 MA5 离场，仅止损逻辑生效。

    T+1(c10.2,ma5=None) init 9.99；T+2 锁定 stop_next=10.48（ma5=None）；
    T+3 low10.50>10.48 不止损、close10.0 大跌但 ma5=None → 不 ma5_exit；
    T+4 low10.40≤10.48 → stop（证明只有止损路径生效）。
    """

    bars = [
        _bar(o=10.0, h=10.3, low=9.8, c=10.2, ma5=None),
        _bar(o=10.4, h=10.6, low=10.5, c=10.5, ma5=None),
        _bar(o=10.5, h=10.55, low=10.50, c=10.0, ma5=None),
        _bar(o=10.45, h=10.5, low=10.40, c=10.42, ma5=None),
    ]
    out = simulate_band_lock(bars, 10.00)
    assert out == BandLockOutcome(
        kind="exit",
        reason="stop",
        exit_index=3,
        exit_price=10.45,
        scheme=1,
        hold_days=3,
    )


# ----------------------------------------------------------------------
# S11：max_hold 兜底（精确 exit_index/hold_days）
# ----------------------------------------------------------------------

def test_s11_max_hold_fallback() -> None:
    """max_hold=10；signal_high 高位不锁定；全程不触发止损（无停牌）→
    在第 10 个可交易持有日 max_hold 兜底 @adj_close，exit_index=10，hold_days=10。
    """

    bars = [_bar(o=10.0, h=10.2, low=9.95, c=10.1)]  # 方案一，init stop=9.99
    for k in range(10):
        px = 10.1 + 0.1 * k
        bars.append(_bar(o=px, h=px + 0.1, low=px, c=px + 0.05))
    assert len(bars) == 11  # indices 0..10
    out = simulate_band_lock(bars, 999.0, max_hold=10)
    assert out.kind == "exit"
    assert out.reason == "max_hold"
    assert out.exit_index == 10
    assert out.hold_days == 10
    assert out.scheme == 1
    # 第 10 根 adj_close = (10.1 + 0.1*9) + 0.05 = 11.05
    assert out.exit_price == 11.05


# ----------------------------------------------------------------------
# S12：窗口耗尽未出场 → no_exit
# ----------------------------------------------------------------------

def test_s12_window_exhausted_no_exit() -> None:
    """无 max_hold，窗口短，未触发任何条件 → no_exit（调用方收口）。"""

    bars = [
        _bar(o=10.0, h=10.2, low=9.95, c=10.1),
        _bar(o=10.1, h=10.3, low=10.05, c=10.2),
    ]
    out = simulate_band_lock(bars, 999.0)
    assert out == BandLockOutcome(kind="no_exit")


# ----------------------------------------------------------------------
# S13：方案二·保本地板锁定当日首次浮盈（验 P3：(2-pre) 先激活地板）
#   构造 floor > low×0.999，锁定当日同时首次 close>cost → 冻结止损 = floor。
#   次日 low 探针锁死冻结止损价 = floor2(cost×0.999)=10.48。
# ----------------------------------------------------------------------

def test_s13_breakeven_floor_locks_same_day_as_lock_triggers() -> None:
    """方案二；锁定日同时 adj_low>signal_high 且首次 adj_close>cost。
    cost=10.5，floor=floor2(10.5×0.999)=10.48；signal_high=9.5。
    T+1(o10.5,l9.0,c10.0)→方案二，init stop=floor2(9.0×0.999)=8.99。
    T+2(l9.6,c10.6)→low9.6>9.5 锁定 且 close10.6>cost10.5 首次浮盈（(2-pre)先激活地板）；
        冻结 stop_next = max(floor2(9.6×0.999)=9.59, floor 10.48)=10.48（地板胜出）。
    T+3 low10.47≤10.48 → stop @min(10.48, open10.5)=10.48（证明冻结止损=10.48）。
    """

    bars = [
        _bar(o=10.5, h=10.5, low=9.0, c=10.0),
        _bar(o=10.55, h=10.7, low=9.6, c=10.6),
        _bar(o=10.5, h=10.5, low=10.47, c=10.48),
    ]
    out = simulate_band_lock(bars, 9.5)
    assert out == BandLockOutcome(
        kind="exit",
        reason="stop",
        exit_index=2,
        exit_price=10.48,
        scheme=2,
        hold_days=2,
    )


def test_s13_breakeven_floor_not_triggered_just_above() -> None:
    """同 S13 构造，但 T+3 low 10.49 > 冻结止损 10.48 → 不触发，no_exit。

    与上一例成对，锁死冻结止损价恰为 floor=10.48（10.47 触发 / 10.49 不触发）：
    若地板未在锁定当日激活，冻结止损会是 9.59，10.47 也不会触发——本对断言证伪该可能。
    """

    bars = [
        _bar(o=10.5, h=10.5, low=9.0, c=10.0),
        _bar(o=10.55, h=10.7, low=9.6, c=10.6),
        _bar(o=10.5, h=10.6, low=10.49, c=10.55),
    ]
    out = simulate_band_lock(bars, 9.5)
    assert out == BandLockOutcome(kind="no_exit")


# ----------------------------------------------------------------------
# 补充：日内止损优先于 MA5 离场（执行顺序铁律）
# ----------------------------------------------------------------------

def test_intraday_stop_precedes_ma5_exit() -> None:
    """同一日 日内止损(1) 优先于 收盘 MA5 离场(2b)。

    构造锁定后某日既触发止损（low≤stop_eff）又满足 MA5 离场条件 →
    必须出 reason='stop'（止损盘中成交、MA5 收盘才判）。
    """

    bars = [
        _bar(o=10.0, h=10.3, low=9.8, c=10.2, ma5=10.0),
        _bar(o=10.4, h=10.6, low=10.5, c=10.5, ma5=10.3),  # 锁定 stop_next=10.48
        # T+3：low10.40≤10.48（止损）且 close10.1<ma5=10.2<prev_ma5=10.3（MA5 也满足）
        _bar(o=10.45, h=10.5, low=10.40, c=10.1, ma5=10.2),
    ]
    out = simulate_band_lock(bars, 10.00)
    assert out.reason == "stop"  # 止损优先，非 ma5_exit
    assert out.exit_index == 2


# ----------------------------------------------------------------------
# 补充：空 bars 防御 → no_exit
# ----------------------------------------------------------------------

def test_empty_bars_returns_no_exit() -> None:
    assert simulate_band_lock([], 10.0) == BandLockOutcome(kind="no_exit")
