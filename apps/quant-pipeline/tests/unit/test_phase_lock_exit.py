"""strategy/phase_lock_exit.py 单测 —— 阶段锁定 phase_lock 对拍样例 S1~S15。

本测试是整个特性的**数值权威源**：TS 同构版（signal-stats.phase-lock.spec.ts）逐数值
镜像本文件的期望（kind/reason/exit_index/exit_price/hold_days/locked），任何偏差都会让跨语言
对拍失败。对应 docs/superpowers/specs/2026-06-13-phase-lock-exit-design/06 §主场景表 的
S1~S15，每个场景在此补全完整 bars 序列与**精确数值断言**。

约定（同 spec 06）：lookback=3、整洁价格、cost = T+1 复权 open、
recent_lows = 含 T+1 的最近 3 个非停牌复权 low（升序）。

与 band_lock 的核心区分点（必须有）：
  S3  阶段A止损固定不上移（band_lock 会因 trailing 出场，phase_lock 不会）
  S7  同日盘中止损优先于 MA5 清仓
  S15 切换当日盘中先触止损 → 出 phase_lock_stop 且当日不锁定（locked=False）
"""

from __future__ import annotations

from quant_pipeline.strategy.phase_lock_exit import (
    DEFAULT_INIT_FACTOR,
    DEFAULT_LOCK_FACTOR,
    DEFAULT_LOOKBACK,
    PhaseLockBar,
    PhaseLockOutcome,
    floor2,
    simulate_phase_lock,
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
) -> PhaseLockBar:
    """测试构造助手（对齐 band_lock 测试写法）。

    未给 raw_open/raw_high 时默认等于复权 open/high（不触发限停板，避免误触）；
    未给 up/down_limit 时默认 None（该端约束不生效）。
    """

    return PhaseLockBar(
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
# 默认常量（本模块是唯一权威源）
# ----------------------------------------------------------------------

def test_module_default_constants() -> None:
    assert DEFAULT_INIT_FACTOR == 0.999
    assert DEFAULT_LOCK_FACTOR == 0.999
    assert DEFAULT_LOOKBACK == 10


# ----------------------------------------------------------------------
# floor2 取整边界（跨语言逐位一致）
# ----------------------------------------------------------------------

def test_floor2_boundaries() -> None:
    assert floor2(9.99) == 9.99
    assert floor2(10.4895) == 10.48
    # 10.567 × 0.999 = 10.556433 → floor2 = 10.55
    assert floor2(10.567 * 0.999) == 10.55
    # 初始止损边界：9.5 × 0.999 = 9.4905 → 9.49
    assert floor2(9.5 * 0.999) == 9.49
    # 锁定止损边界：10.5 × 0.999 = 10.4895 → 10.48
    assert floor2(10.5 * 0.999) == 10.48
    # if=1.0 不去缓冲，但 floor2 截断仍生效：9.5 × 1.0 = 9.50
    assert floor2(9.5 * 1.0) == 9.50


# ----------------------------------------------------------------------
# S1：阶段A盘中止损（精确数值）
# ----------------------------------------------------------------------

def test_s1_phase_a_intraday_stop() -> None:
    """recent_lows=[10.0,9.8,9.5], init_factor=1.0 → init_stop=floor2(9.5)=9.50。
    T+1(o10,l9.5,c10.0)；T+2 low9.4≤9.50 触发, open9.6≥stop → fill=min(9.50,9.60)=9.50。
    exit_index=1, hold_days=1, locked=False（阶段 A 未锁定）。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0),
        _bar(o=9.6, h=9.7, low=9.4, c=9.45),
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=1.0)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=1,
        exit_price=9.50,
        hold_days=1,
        locked=False,
    )


# ----------------------------------------------------------------------
# S2：阶段A跳空低开止损 → exit_price = open（min 取开盘）
# ----------------------------------------------------------------------

def test_s2_phase_a_gap_down_fills_at_open() -> None:
    """同 S1 init_stop=9.50；T+2 跳空低开 open9.30(<stop), low9.20≤9.50 → fill=min(9.50,9.30)=9.30。"""

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0),
        _bar(o=9.30, h=9.35, low=9.20, c=9.25),
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=1.0)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=1,
        exit_price=9.30,
        hold_days=1,
        locked=False,
    )


# ----------------------------------------------------------------------
# S3：阶段A止损固定不上移（与 band_lock 的核心差异）
# ----------------------------------------------------------------------

def test_s3_phase_a_stop_does_not_trail() -> None:
    """init_stop=floor2(9.5×1.0)=9.50（recent_lows=[10.0,9.8,9.5], if=1.0）。
    T+2 大涨（low10.5）但 ma5=None → 不满足阶段切换、不锁定；阶段 A 止损**固定**仍=9.50（不抬到 ~10.5）。
    T+3 low9.6 介于 init_stop(9.50) 与 T+2 low(10.5) 之间 → 9.6>9.50 不止损。
    band_lock 会因 trailing 把 stop 抬到 floor2(10.5×0.999)=10.48 → 9.6≤10.48 出场；
    phase_lock **不会**——窗口耗尽 no_exit，locked=False。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0),
        _bar(o=10.4, h=10.6, low=10.5, c=10.55, ma5=None),  # 大涨但 ma5=None → 不锁
        _bar(o=10.0, h=10.2, low=9.6, c=10.1, ma5=None),    # low9.6>init_stop9.50 → 不止损
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=0.999)
    assert out == PhaseLockOutcome(kind="no_exit", locked=False, hold_days=2)


# ----------------------------------------------------------------------
# S4：阶段切换 + 次日生效（锁定，切换当日不出场）
# ----------------------------------------------------------------------

def test_s4_phase_switch_locks_next_day_effective() -> None:
    """recent_lows=[10.0,9.8,9.5], if=0.999 → init_stop=floor2(9.4905)=9.49。
    cost=10.0，lf=0.999。
    T+1(o10,l9.5,c10.0,ma5=9.6)→prev_ma5=9.6。
    T+2(o10.2,l10.5,c10.6,ma5=9.8)→close10.6>ma5 9.8 且 ma5 9.8>prev 9.6 → 锁定；
        new stop_next=floor2(max(cost10.0,low10.5)×0.999)=floor2(10.4895)=10.48；切换当日不出场。
    T+3(o10.6,l10.55,c10.7,ma5=10.0)→low10.55>10.48 不止损；close10.7>ma5 不清仓 → 持有。
    窗口耗尽 → no_exit，locked=True（曾进入阶段 B），hold_days=2。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0, ma5=9.6),
        _bar(o=10.2, h=10.7, low=10.5, c=10.6, ma5=9.8),
        _bar(o=10.6, h=10.8, low=10.55, c=10.7, ma5=10.0),
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=0.999, lock_factor=0.999)
    assert out == PhaseLockOutcome(kind="no_exit", locked=True, hold_days=2)


# ----------------------------------------------------------------------
# S5：阶段B止损（锁定后盘中触锁定止损）
# ----------------------------------------------------------------------

def test_s5_phase_b_stop() -> None:
    """承 S4 锁定 stop_next=10.48（lf=0.999, max(cost10,low10.5)=10.5）。
    T+3 跌：low10.40≤10.48 触发，open10.5≥stop → fill=min(10.48,10.5)=10.48。
    exit_index=2, hold_days=2, locked=True。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0, ma5=9.6),
        _bar(o=10.2, h=10.7, low=10.5, c=10.6, ma5=9.8),     # 锁定 stop=10.48
        _bar(o=10.5, h=10.6, low=10.40, c=10.42, ma5=10.0),  # low10.40≤10.48 触发
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=0.999, lock_factor=0.999)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=2,
        exit_price=10.48,
        hold_days=2,
        locked=True,
    )


# ----------------------------------------------------------------------
# S6：阶段B MA5 清仓（close<MA5 且 MA5<prev_ma5 → 按收盘价）
# ----------------------------------------------------------------------

def test_s6_phase_b_ma5_exit() -> None:
    """承 S4 锁定（T+2 后 prev_ma5=9.8）。
    T+3(o10.6,l10.50,c10.7,ma5=10.0)→low10.50>10.48 不止损；close10.7>ma5 不清仓；prev_ma5→10.0。
    T+4(o10.5,l10.49,c9.9,ma5=9.95)→low10.49>10.48 不止损；
        close9.9<ma5 9.95 且 ma5 9.95<prev 10.0 → phase_lock_ma5 @close9.9。
    exit_index=3, hold_days=3, locked=True。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0, ma5=9.6),
        _bar(o=10.2, h=10.7, low=10.5, c=10.6, ma5=9.8),      # 锁定 stop=10.48
        _bar(o=10.6, h=10.8, low=10.50, c=10.7, ma5=10.0),    # 持有；prev_ma5→10.0
        _bar(o=10.5, h=10.6, low=10.49, c=9.9, ma5=9.95),     # MA5 清仓
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=0.999, lock_factor=0.999)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_ma5",
        exit_index=3,
        exit_price=9.9,
        hold_days=3,
        locked=True,
    )


# ----------------------------------------------------------------------
# S7：同日盘中止损优先于 MA5 清仓（阶段B；当日不评估收盘）
# ----------------------------------------------------------------------

def test_s7_intraday_stop_precedes_ma5_exit() -> None:
    """阶段 B 某日同时满足盘中止损（low≤stop）与 MA5 清仓（close<MA5↓）→ 必出 phase_lock_stop。
    承 S4 锁定 stop=10.48（prev_ma5 处理到 T+2 后=9.8，T+3 后=10.0）。
    T+4(o10.5,l10.40,c9.9,ma5=9.95)：low10.40≤10.48（止损）**且** close9.9<ma5 9.95<prev 10.0（MA5 也满足）
        → 止损盘中成交、当日不评估收盘 → phase_lock_stop @min(10.48,open10.5)=10.48。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0, ma5=9.6),
        _bar(o=10.2, h=10.7, low=10.5, c=10.6, ma5=9.8),      # 锁定 stop=10.48
        _bar(o=10.6, h=10.8, low=10.50, c=10.7, ma5=10.0),    # 持有；prev_ma5→10.0
        _bar(o=10.5, h=10.6, low=10.40, c=9.9, ma5=9.95),     # 止损与 MA5 同日
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=0.999, lock_factor=0.999)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",  # 止损优先，非 phase_lock_ma5
        exit_index=3,
        exit_price=10.48,
        hold_days=3,
        locked=True,
    )


# ----------------------------------------------------------------------
# S8：不足 lookback 根降级（次新股，仅 2 根可用）
# ----------------------------------------------------------------------

def test_s8_short_recent_lows_degrades() -> None:
    """lookback=3 但只 2 根可用 → init_stop=floor2(min(2根低)×if)，不 no_entry。
    recent_lows=[9.8,9.6], if=1.0 → init_stop=floor2(9.6)=9.60。
    T+2 low9.5≤9.60 触发, open9.7≥stop → fill=min(9.60,9.70)=9.60。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.8, c=9.9),
        _bar(o=9.7, h=9.8, low=9.5, c=9.55),
    ]
    out = simulate_phase_lock(bars, [9.8, 9.6], init_factor=1.0, lock_factor=1.0)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=1,
        exit_price=9.60,
        hold_days=1,
        locked=False,
    )


def test_s8b_empty_recent_lows_no_initial_stop() -> None:
    """空 recent_lows（理论不会）→ init_stop=None → 阶段 A 无盘中止损（即便低开暴跌也不止损）。

    交由阶段切换接管；本例无 ma5 → 不锁、不清仓 → 窗口耗尽 no_exit。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.8, c=9.9),
        _bar(o=9.0, h=9.1, low=8.0, c=8.5),  # 暴跌但 init_stop=None → 不止损
    ]
    out = simulate_phase_lock(bars, [], init_factor=1.0, lock_factor=1.0)
    assert out == PhaseLockOutcome(kind="no_exit", locked=False, hold_days=1)


# ----------------------------------------------------------------------
# S9：停牌跨越 → 不计 hold、不动 stop、不动 prev_ma5
# ----------------------------------------------------------------------

def test_s9_suspended_day_skipped() -> None:
    """持仓中插一个停牌 bar（adj_* 全 None）→ 该日不计 hold、不触发、不更新止损。
    init_stop=floor2(9.5×1.0)=9.50。
    T+2 停牌跳过；T+3 low9.4≤9.50 触发, open9.6 → fill=min(9.50,9.60)=9.50。
    hold_days=1（停牌日不计），exit_index=2。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0),
        _bar(),  # 停牌：adj_* 全 None
        _bar(o=9.6, h=9.7, low=9.4, c=9.45),
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=1.0)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=2,
        exit_price=9.50,
        hold_days=1,
        locked=False,
    )


def test_s9b_suspended_via_is_suspended_flag() -> None:
    """冗余防御：is_suspended=True 但价格非 None 也按停牌跳过（与 adj_close=None 等价）。"""

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0),
        _bar(o=9.6, h=9.7, low=9.4, c=9.45, sus=True),  # 标记停牌（但有价）→ 跳过，不止损
        _bar(o=9.6, h=9.7, low=9.4, c=9.45),            # 真正触发日
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=1.0)
    assert out.kind == "exit"
    assert out.reason == "phase_lock_stop"
    assert out.exit_index == 2
    assert out.hold_days == 1  # 停牌日不计


# ----------------------------------------------------------------------
# S10：封死跌停顺延（止损）→ 次日非封死 @adj_open，reason 保留
# ----------------------------------------------------------------------

def test_s10_dead_limit_down_defers_stop() -> None:
    """止损触发日封死跌停（raw_high≤down_limit）→ pending='phase_lock_stop' 顺延；
    次日非封死 → 出场 @adj_open(次日)，reason 保留。
    init_stop=floor2(9.5×1.0)=9.50。
    T+2 low9.4≤9.50 触发，但 raw_high9.7≤down_limit9.7（封死）→ 顺延；
    T+3 非封死 → exit @adj_open(T+3)=9.3，exit_index=2，hold_days=2。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0),
        _bar(o=9.6, h=9.7, low=9.4, c=9.45, rh=9.7, dn=9.7),  # 封死跌停
        _bar(o=9.3, h=9.4, low=9.2, c=9.3),                   # 次日非封死
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=1.0)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=2,
        exit_price=9.3,
        hold_days=2,
        locked=False,
    )


# ----------------------------------------------------------------------
# S11：封死跌停顺延（MA5 清仓）→ 次日非封死 @adj_open，reason 保留
# ----------------------------------------------------------------------

def test_s11_dead_limit_down_defers_ma5() -> None:
    """阶段 B MA5 清仓应触发当日封死跌停 → pending='phase_lock_ma5' 顺延；次日非封死 @adj_open。
    承 S4 锁定 stop=10.48（T+2 后 prev_ma5=9.8）。
    T+3(o10.6,l10.50,c10.7,ma5=10.0)→持有；prev_ma5→10.0。
    T+4(o10.5,l10.49,c9.9,ma5=9.95)→low10.49>10.48 不止损；close9.9<ma5 9.95<prev 10.0 清仓，
        但 raw_high10.6≤down_limit10.6（封死）→ pending='phase_lock_ma5'，prev_ma5→9.95，顺延。
    T+5(o9.8,l9.7,c9.75)→非封死 → exit @adj_open9.8，reason 保留，exit_index=4，hold_days=4。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0, ma5=9.6),
        _bar(o=10.2, h=10.7, low=10.5, c=10.6, ma5=9.8),      # 锁定 stop=10.48
        _bar(o=10.6, h=10.8, low=10.50, c=10.7, ma5=10.0),    # 持有；prev_ma5→10.0
        _bar(o=10.5, h=10.6, low=10.49, c=9.9, ma5=9.95,
             rh=10.6, dn=10.6),                               # MA5 清仓但封死跌停 → 顺延
        _bar(o=9.8, h=9.9, low=9.7, c=9.75, ma5=9.9),         # 次日非封死
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=0.999, lock_factor=0.999)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_ma5",
        exit_index=4,
        exit_price=9.8,
        hold_days=4,
        locked=True,
    )


# ----------------------------------------------------------------------
# S12：涨停开盘不入场 → no_entry / limit_up
# ----------------------------------------------------------------------

def test_s12_limit_up_no_entry() -> None:
    """T+1 raw_open ≥ up_limit → 买不进，no_entry(reason='limit_up')。"""

    bars = [_bar(o=10.0, h=10.0, low=10.0, c=10.0, ro=10.0, up=10.0)]
    out = simulate_phase_lock(bars, [10.0], init_factor=0.999, lock_factor=0.999)
    assert out == PhaseLockOutcome(kind="no_entry", reason="limit_up")


def test_s12b_limit_up_strict_below_does_enter() -> None:
    """raw_open < up_limit（未顶格）→ 可买入，不判 limit_up。"""

    bars = [_bar(o=9.99, h=10.0, low=9.9, c=9.95, ro=9.99, up=10.0)]
    out = simulate_phase_lock(bars, [9.9], init_factor=0.999, lock_factor=0.999)
    # 单根窗口、未触发任何出场 → no_exit（证明入场成立）
    assert out.kind == "no_exit"


def test_entry_suspended_no_entry() -> None:
    """T+1 停牌（adj_open/adj_close 为 None）→ no_entry(reason='suspended')。"""

    bars = [_bar()]  # 全 None
    out = simulate_phase_lock(bars, [], init_factor=0.999, lock_factor=0.999)
    assert out == PhaseLockOutcome(kind="no_entry", reason="suspended")


# ----------------------------------------------------------------------
# S13：窗口耗尽未出场 → no_exit
# ----------------------------------------------------------------------

def test_s13_window_exhausted_no_exit() -> None:
    """全程不触止损/不锁/不清仓 → no_exit（调用方收口），exit_index=None。
    init_stop=floor2(9.5×0.999)=9.49；后续 low 均高于 9.49 且无 ma5 → 不锁。
    """

    bars = [
        _bar(o=10.0, h=10.2, low=9.5, c=10.1),
        _bar(o=10.1, h=10.3, low=10.0, c=10.2),
        _bar(o=10.2, h=10.4, low=10.1, c=10.3),
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=0.999, lock_factor=0.999)
    assert out == PhaseLockOutcome(kind="no_exit", locked=False, hold_days=2)


# ----------------------------------------------------------------------
# S14：两个独立 factor 生效（init_factor 与 lock_factor 互不串用）
# ----------------------------------------------------------------------

def test_s14_two_independent_factors() -> None:
    """if=0.98（仅作用初始止损），lf=1.005（仅作用锁定止损）。
    recent_lows=[10.0,9.8,9.5] → init_stop=floor2(9.5×0.98)=floor2(9.31)=9.31。
    cost=10.0。
    T+1(o10,l9.5,c10.0,ma5=9.6)→prev_ma5=9.6。
    T+2(o10.2,l10.5,c10.6,ma5=9.8)→close>ma5 且 ma5↑ 锁定；
        new stop=floor2(max(cost10,low10.5)×1.005)=floor2(10.5×1.005)=floor2(10.5525)=10.55。
    T+3(o10.6,l10.54,c10.6,ma5=10.0)→low10.54≤10.55 触发, open10.6≥stop → fill=min(10.55,10.6)=10.55。
    若误把 if 用到锁定（0.98）→ stop 会是 floor2(10.5×0.98)=10.29，T+3 low10.54 不会触发——本例证伪该串用。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0, ma5=9.6),
        _bar(o=10.2, h=10.7, low=10.5, c=10.6, ma5=9.8),     # 锁定 stop=10.55（lf=1.005）
        _bar(o=10.6, h=10.7, low=10.54, c=10.6, ma5=10.0),   # low10.54≤10.55 触发
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=0.98, lock_factor=1.005)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=2,
        exit_price=10.55,
        hold_days=2,
        locked=True,
    )


def test_s14b_init_factor_only_on_initial_stop() -> None:
    """对照：if=0.98 锁死 init_stop=9.31。
    T+2 low9.30≤9.31 阶段 A 触发, open9.5≥stop → fill=min(9.31,9.5)=9.31（证明 if 作用于初始止损）。
    若误用 lf 到初始（本例 lf=1.005 → floor2(9.5×1.005)=9.54）→ low9.30 也会触发但成交价不同——
    本例成交价=9.31 锁死用的是 if=0.98。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0),
        _bar(o=9.5, h=9.6, low=9.30, c=9.35),
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=0.98, lock_factor=1.005)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=1,
        exit_price=9.31,
        hold_days=1,
        locked=False,
    )


# ----------------------------------------------------------------------
# S15：切换当日盘中先止损 → phase_lock_stop 且当日不锁定（locked=False）
# ----------------------------------------------------------------------

def test_s15_switch_day_intraday_stop_first_no_lock() -> None:
    """T+2 盘中 low≤init_stop **且**（若不止损则会满足切换条件 close>MA5↑）→ 止损优先，当日不锁定。
    if=1.0 → init_stop=floor2(9.5×1.0)=9.50。
    T+1(o10,l9.5,c10.0,ma5=9.6)→prev_ma5=9.6。
    T+2(o9.6,l9.4,c10.6,ma5=9.8)：low9.4≤9.50（止损）；
        收盘本会满足切换（close10.6>ma5 9.8 且 ma5 9.8>prev 9.6）——但盘中止损优先、当日不评估收盘。
        → phase_lock_stop @min(9.50,open9.6)=9.50；locked=False（**未**进入阶段 B）。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0, ma5=9.6),
        _bar(o=9.6, h=10.7, low=9.4, c=10.6, ma5=9.8),  # 止损与切换条件同日
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=0.999)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=1,
        exit_price=9.50,
        hold_days=1,
        locked=False,  # 当日先止损，未锁定
    )


# ----------------------------------------------------------------------
# 补充：持仓首日不自止损（初始止损 T+2 才生效）
# ----------------------------------------------------------------------

def test_entry_day_never_self_stops() -> None:
    """T+1 当天 low(8.0) 远低于 init_stop(9.50)，但持仓首日不评估止损。

    单根窗口 → no_exit（持仓首日不出场，证明初始止损 T+2 才生效）。
    """

    bars = [_bar(o=10.0, h=10.2, low=8.0, c=10.1)]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=1.0)
    assert out == PhaseLockOutcome(kind="no_exit", locked=False, hold_days=0)


# ----------------------------------------------------------------------
# 补充：MA5 预热不足（ma5=None）→ 不锁、不清仓，仅止损逻辑
# ----------------------------------------------------------------------

def test_ma5_warmup_none_no_phase_switch() -> None:
    """ma5=None → 阶段切换守卫跳过（永不锁定），仅阶段 A 止损生效。
    init_stop=floor2(9.5×1.0)=9.50。
    T+2 大涨 low10.5（ma5=None 不锁）；T+3 跌破 low9.4≤9.50 → phase_lock_stop。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0, ma5=None),
        _bar(o=10.4, h=10.6, low=10.5, c=10.55, ma5=None),
        _bar(o=9.6, h=9.7, low=9.4, c=9.45, ma5=None),
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5], init_factor=1.0, lock_factor=1.0)
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=2,
        exit_price=9.50,
        hold_days=2,
        locked=False,
    )


# ----------------------------------------------------------------------
# 补充：空 bars 防御 → no_exit
# ----------------------------------------------------------------------

def test_empty_bars_returns_no_exit() -> None:
    assert simulate_phase_lock([], [10.0]) == PhaseLockOutcome(kind="no_exit")


# ----------------------------------------------------------------------
# 补充：默认参数（0.999/0.999）可省略调用
# ----------------------------------------------------------------------

def test_default_factors_applied() -> None:
    """不传 init_factor/lock_factor → 用模块默认 0.999/0.999。
    init_stop=floor2(9.5×0.999)=9.49；T+2 low9.48≤9.49 触发, open9.6 → fill=9.49。
    """

    bars = [
        _bar(o=10.0, h=10.1, low=9.5, c=10.0),
        _bar(o=9.6, h=9.7, low=9.48, c=9.5),
    ]
    out = simulate_phase_lock(bars, [10.0, 9.8, 9.5])
    assert out == PhaseLockOutcome(
        kind="exit",
        reason="phase_lock_stop",
        exit_index=1,
        exit_price=9.49,
        hold_days=1,
        locked=False,
    )
