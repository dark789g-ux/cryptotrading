"""labels/phase_lock_labels.py 单测（phase-lock-exit-design spec 03 §三）。

镜像 test_labels_band_lock.py，覆盖 phase_lock 独立有状态 scheme 的标签产出：
阶段 A 盘中止损、阶段切换 + 锁定 + MA5 清仓、停牌跳过、封死跌停顺延、
no_exit→force_close 收口、退市截断，以及**本 scheme 特有**的 recent_lows 装配
（切片 / 左扩 / 不足 lookback 根降级 / 停牌跳过）。不连 DB / 纯 pandas。

口径要点（与 strategy_aware / band_lock 的差异，仅本 scheme）：
  - 买入价 = T+1 hfq open_adj（非 close_adj）。
  - **不**取 signal_high；初始止损用 recent_lows（含 T+1 的最近 lookback 个非停牌
    在场行 low_adj，升序），由数据层切好传给核。
  - 共享核 simulate_phase_lock 已有 S1~S15 单测锁住逐 bar 行为，本测聚焦
    "标签层装配 + recent_lows 切片 + 落库口径（value/exit_reason/hold_days/scheme）"。
"""

from __future__ import annotations

import math

import pandas as pd

from quant_pipeline.labels.phase_lock_labels import (
    PHASE_LOCK_SCHEME,
    _ensure_ma5,
    _slice_recent_lows,
    compute_phase_lock_labels,
)
from quant_pipeline.labels.strategy_aware import LabelInputs


def _quotes(rows: list[dict], ts_code: str = "X") -> pd.DataFrame:
    """构造 phase_lock 所需 quotes：hfq open/high/low/close + raw open/high。

    rows 每项给 trade_date + raw open/high/low/close；默认 adj_factor=1 →
    hfq == raw（测试聚焦标签装配，复权倍数不影响相对收益与触发逻辑）。
    可在 row 里显式给 close_adj/low_adj/... 覆盖。
    """

    df = pd.DataFrame(rows)
    df["ts_code"] = df.get("ts_code", ts_code)
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
# _slice_recent_lows：含 T+1 的最近 lookback 个非停牌在场行 low_adj（升序）
# ----------------------------------------------------------------------

def _sub_for_slice() -> pd.DataFrame:
    """单票 4 行（含 buy_date 之后一行），注入 ma5，供 _slice_recent_lows 直接测。"""

    sub = _quotes(
        [
            {"trade_date": "20240101", "open": 10.0, "high": 10.1, "low": 9.9, "close": 10.0},
            {"trade_date": "20240102", "open": 10.0, "high": 10.2, "low": 9.7, "close": 10.1},
            # 20240103 = buy_date
            {"trade_date": "20240103", "open": 10.0, "high": 10.3, "low": 9.5, "close": 10.2},
            # 20240104 = buy_date 之后（不应进 recent_lows）
            {"trade_date": "20240104", "open": 10.0, "high": 10.4, "low": 9.3, "close": 10.3},
        ]
    )
    return _ensure_ma5(sub.sort_values("trade_date").reset_index(drop=True))


def test_slice_recent_lows_basic() -> None:
    """切含 buy_date 的最近 lookback 个在场行 low_adj（升序=按 trade_date 升序）。

    lookback=2 → buy_date(20240103) 及其前 1 根：[9.7, 9.5]（不含 20240104，buy_date 之后）。
    """

    sub = _sub_for_slice()
    lows = _slice_recent_lows(
        sub, buy_date="20240103", lookback=2, suspended_set=set(), ts_code="X"
    )
    assert lows == [9.7, 9.5]


def test_slice_recent_lows_excludes_after_buy_date() -> None:
    """buy_date 之后的行（20240104, low=9.3）绝不进 recent_lows（PIT 安全）。"""

    sub = _sub_for_slice()
    lows = _slice_recent_lows(
        sub, buy_date="20240103", lookback=10, suspended_set=set(), ts_code="X"
    )
    assert 9.3 not in lows
    assert max(lows) <= 9.9  # 全部 <= buy_date 当日及之前


def test_slice_recent_lows_short_degrades() -> None:
    """不足 lookback 根 → 用现有可用根数（不报错、不补零）。

    sub 仅 3 行 <= buy_date，lookback=10 → 返回全部 3 根 [9.9, 9.7, 9.5]。
    """

    sub = _sub_for_slice()
    lows = _slice_recent_lows(
        sub, buy_date="20240103", lookback=10, suspended_set=set(), ts_code="X"
    )
    assert lows == [9.9, 9.7, 9.5]


def test_slice_recent_lows_skips_suspended() -> None:
    """suspend_d 标记的停牌日（冗余防御）不计入 recent_lows。

    标 20240102 停牌、lookback=3 → 跳过 9.7，返回 [9.9, 9.5]（只 2 根，停牌后降级）。
    """

    sub = _sub_for_slice()
    lows = _slice_recent_lows(
        sub,
        buy_date="20240103",
        lookback=3,
        suspended_set={("X", "20240102")},
        ts_code="X",
    )
    assert lows == [9.9, 9.5]


def test_slice_recent_lows_skips_nan_low() -> None:
    """low_adj 缺失（NaN）的行不计入（复权因子缺 / 停牌缺行）。"""

    sub = _quotes(
        [
            {"trade_date": "20240101", "open": 10.0, "high": 10.1, "low": 9.9, "close": 10.0},
            {"trade_date": "20240102", "open": 10.0, "high": 10.2, "low": 9.7, "close": 10.1},
            {"trade_date": "20240103", "open": 10.0, "high": 10.3, "low": 9.5, "close": 10.2},
        ]
    )
    sub.loc[sub["trade_date"] == "20240102", "low_adj"] = float("nan")
    sub = _ensure_ma5(sub.sort_values("trade_date").reset_index(drop=True))
    lows = _slice_recent_lows(
        sub, buy_date="20240103", lookback=3, suspended_set=set(), ts_code="X"
    )
    assert lows == [9.9, 9.5]


# ----------------------------------------------------------------------
# 阶段 A 盘中止损（init_factor 作用于 min(recent_lows)）
# ----------------------------------------------------------------------

def test_phase_a_intraday_stop() -> None:
    """阶段 A：init_stop=floor2(min(recent_lows)×init_factor) 固定不上移；T+2 触发。

    lookback=3、init_factor=1.0；信号日 T=20240101。
    recent_lows = 含 T+1(20240102) 的最近 3 根在场 low：[9.8(T), 9.5(T+1) ...]。
    构造使 min(recent_lows)=9.5 → init_stop=floor2(9.5)=9.50。
    T+1(o10,l9.5,c10.0)；T+2(l9.4)≤9.50 触发，open9.6≥stop → fill=min(9.50,9.6)=9.50。
    buy_price=open(T+1)=10.0 → value=9.50/10.0-1=-0.05；hold_days=1。
    """

    rows = [
        # 左扩两根（供 recent_lows 凑足 lookback=3 ；但 min 由 T/T+1 决定）
        {"trade_date": "20231229", "open": 10.2, "high": 10.3, "low": 10.0, "close": 10.1},
        {"trade_date": "20231230", "open": 10.0, "high": 10.1, "low": 9.8, "close": 9.9},
        # 信号日 T（low=9.5）
        {"trade_date": "20240101", "open": 9.6, "high": 9.7, "low": 9.5, "close": 9.6},
        # T+1 持仓首日（low=9.5）
        {"trade_date": "20240102", "open": 10.0, "high": 10.1, "low": 9.5, "close": 10.0},
        # T+2 触止损
        {"trade_date": "20240103", "open": 9.6, "high": 9.7, "low": 9.4, "close": 9.45},
        {"trade_date": "20240104", "open": 9.4, "high": 9.5, "low": 9.3, "close": 9.4},
    ]
    out = compute_phase_lock_labels(
        LabelInputs(daily_quotes=_quotes(rows), entries=_entries("20240101"), end="20240104"),
        init_factor=1.0,
        lock_factor=1.0,
        lookback=3,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["trade_date"] == "20240101"
    assert row["scheme"] == PHASE_LOCK_SCHEME
    assert row["exit_reason"] == "phase_lock_stop"
    assert row["hold_days"] == 1
    assert math.isclose(row["value"], 9.50 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 阶段切换 + 锁定 + MA5 清仓（承 exit-test S4/S6 序列）
# ----------------------------------------------------------------------

def test_phase_switch_lock_then_ma5_exit() -> None:
    """阶段切换锁定后某日 close<ma5 且 ma5<prev_ma5 → phase_lock_ma5 @adj_close。

    经 labels 层装配：MA5 由 _ensure_ma5 真实算出（4 根预热让信号日 T+1 起 MA5 可用），
    recent_lows 由数据层切。MA5 在持仓中先升后降（见下表，由 _ensure_ma5 实算）：
        20240108 ma5=10.28（T+1）… 20240111 ma5=10.86（T+4）… 20240112 ma5=10.98（升）
        20240115 ma5=10.93 < prev 10.98（首次拐头向下）且 close10.55 < ma5 → 清仓。
    lock_factor=0.95 → 锁定 stop 足够低（不抢先盘中止损），使 MA5 路径干净触发。

    关键断言：reason=phase_lock_ma5、buy_price=open(T+1=20240108)=10.0、
    exit @20240115 adj_close=10.55 → value=10.55/10.0-1=0.055、hold_days=5。
    """

    rows = [
        # 4 根预热（让 MA5 在 T+1=20240108 起可用）
        {"trade_date": "20240101", "open": 10.0, "high": 10.2, "low": 9.9, "close": 10.0},
        {"trade_date": "20240102", "open": 10.1, "high": 10.3, "low": 10.0, "close": 10.2},
        {"trade_date": "20240103", "open": 10.3, "high": 10.5, "low": 10.2, "close": 10.4},
        {"trade_date": "20240104", "open": 9.9, "high": 10.0, "low": 9.8, "close": 10.0},
        # 信号日 T=20240105
        {"trade_date": "20240105", "open": 9.9, "high": 10.0, "low": 9.8, "close": 10.0},
        # T+1 持仓首日（buy_price=open=10.0）
        {"trade_date": "20240108", "open": 10.0, "high": 10.9, "low": 9.95, "close": 10.8},
        # T+2 阶段切换锁定（close11.2>ma5 10.48↑）
        {"trade_date": "20240109", "open": 10.9, "high": 11.3, "low": 10.7, "close": 11.2},
        {"trade_date": "20240110", "open": 11.2, "high": 11.4, "low": 11.0, "close": 11.3},
        {"trade_date": "20240111", "open": 11.1, "high": 11.2, "low": 10.9, "close": 11.0},
        # MA5 仍在升（10.98>10.86）→ 不清仓
        {"trade_date": "20240112", "open": 10.9, "high": 11.0, "low": 10.75, "close": 10.6},
        # MA5 首次拐头向下（10.93<10.98）且 close10.55<ma5 → phase_lock_ma5
        {"trade_date": "20240115", "open": 10.6, "high": 10.7, "low": 10.5, "close": 10.55},
    ]
    out = compute_phase_lock_labels(
        LabelInputs(daily_quotes=_quotes(rows), entries=_entries("20240105"), end="20240115"),
        init_factor=0.999,
        lock_factor=0.95,  # 锁定 stop 偏低 → MA5 路径不被盘中止损抢先
        lookback=3,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "phase_lock_ma5"
    assert row["hold_days"] == 5
    # 出场 @20240115 adj_close=10.55；买入价 = open(T+1=20240108)=10.0。
    assert math.isclose(row["value"], 10.55 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 停牌日跳过（持仓期某日停牌 → 不计 hold、不触发）
# ----------------------------------------------------------------------

def test_suspended_day_skipped() -> None:
    """持仓期某日在 suspend_d → 该日不计 hold、不触发；出场 hold_days 不含停牌日。

    lookback=3、init_factor=1.0。recent_lows min=9.5 → init_stop=floor2(9.5)=9.50。
    标 T+2(20240103) 停牌（即便有行也按停牌处理）；止损在 T+3(20240104) 才触发，
    T+2 不计 hold → 触发时 hold_days=1（只数 T+1、T+3 中的可交易日）。
    """

    rows = [
        {"trade_date": "20231230", "open": 10.0, "high": 10.1, "low": 9.8, "close": 9.9},
        {"trade_date": "20240101", "open": 9.6, "high": 9.7, "low": 9.5, "close": 9.6},
        {"trade_date": "20240102", "open": 10.0, "high": 10.1, "low": 9.5, "close": 10.05},
        # T+2 停牌
        {"trade_date": "20240103", "open": 10.0, "high": 10.1, "low": 9.0, "close": 9.5},
        # T+3 真正触止损（low 9.4≤9.50）
        {"trade_date": "20240104", "open": 9.6, "high": 9.7, "low": 9.4, "close": 9.45},
        {"trade_date": "20240105", "open": 9.4, "high": 9.5, "low": 9.3, "close": 9.4},
    ]
    suspend = pd.DataFrame({"ts_code": ["X"], "trade_date": ["20240103"]})
    out = compute_phase_lock_labels(
        LabelInputs(
            daily_quotes=_quotes(rows),
            suspend_d=suspend,
            entries=_entries("20240101"),
            end="20240105",
        ),
        init_factor=1.0,
        lock_factor=1.0,
        lookback=3,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "phase_lock_stop"
    assert row["hold_days"] == 1


# ----------------------------------------------------------------------
# 封死跌停顺延（止损触发日封死跌停 → 次日 @adj_open）
# ----------------------------------------------------------------------

def test_dead_limit_down_defers_exit() -> None:
    """止损触发日封死跌停（raw_high≤down_limit）→ 顺延到次日 @adj_open，reason 保留。

    init_stop=floor2(9.5×1.0)=9.50。T+2 止损触发(low 9.0≤9.50) 且封死跌停
    (raw_high 9.2≤down_limit 9.2) → 顺延；T+3 非封死 → 出场 @adj_open=9.3。
    value=9.3/10.0-1。
    """

    rows = [
        {"trade_date": "20231230", "open": 10.0, "high": 10.1, "low": 9.8, "close": 9.9},
        {"trade_date": "20240101", "open": 9.6, "high": 9.7, "low": 9.5, "close": 9.6},
        {"trade_date": "20240102", "open": 10.0, "high": 10.1, "low": 9.5, "close": 10.05},
        # T+2 止损触发 + 封死跌停
        {"trade_date": "20240103", "open": 9.2, "high": 9.2, "low": 9.0, "close": 9.0},
        # T+3 非封死 → 顺延出场 @adj_open=9.3
        {"trade_date": "20240104", "open": 9.3, "high": 9.5, "low": 9.1, "close": 9.4},
    ]
    stk_limit = pd.DataFrame(
        [
            {"ts_code": "X", "trade_date": "20240103", "up_limit": 11.0, "down_limit": 9.2},
            {"ts_code": "X", "trade_date": "20240104", "up_limit": 10.5, "down_limit": 8.4},
        ]
    )
    out = compute_phase_lock_labels(
        LabelInputs(
            daily_quotes=_quotes(rows),
            stk_limit=stk_limit,
            entries=_entries("20240101"),
            end="20240104",
        ),
        init_factor=1.0,
        lock_factor=1.0,
        lookback=3,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "phase_lock_stop"
    assert math.isclose(row["value"], 9.3 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# no_exit → force_close 兜底
# ----------------------------------------------------------------------

def test_no_exit_force_close() -> None:
    """窗口耗尽未出场（不触止损/不锁/不清仓）→ force_close @最后有效 adj_close。

    init_factor=0.999、ma5=None（缓涨但无足够预热 → 不锁）；low 始终高于 init_stop。
    无 max_hold → 窗口耗尽 no_exit → force_close。
    """

    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 10.2, "low": 9.5, "close": 10.1},
        {"trade_date": "20240102", "open": 10.1, "high": 10.3, "low": 10.0, "close": 10.2},
        {"trade_date": "20240103", "open": 10.2, "high": 10.4, "low": 10.1, "close": 10.3},
        {"trade_date": "20240104", "open": 10.3, "high": 10.5, "low": 10.2, "close": 10.4},
    ]
    out = compute_phase_lock_labels(
        LabelInputs(daily_quotes=_quotes(rows), entries=_entries("20240101"), end="20240104"),
        init_factor=0.999,
        lock_factor=0.999,
        lookback=3,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "force_close"
    # buy_price=open(T+1=20240102)=10.1；兜底取最后有效 adj_close=10.4。
    assert math.isclose(row["value"], 10.4 / 10.1 - 1.0, rel_tol=1e-9)
    # hold_days = T+2、T+3 两个可交易持有日。
    assert row["hold_days"] == 2


# ----------------------------------------------------------------------
# 退市 force_close：窗口截断到退市日之前 → force_close 收口
# ----------------------------------------------------------------------

def test_delist_force_close() -> None:
    """退市股：窗口截到 delist_date 前，核耗尽返回 no_exit → force_close @退市前末日。

    delist_date=20240105；窗口仅含 < 20240105 的行（T+1=20240102、20240103、20240104），
    全程不触发任何条件 → force_close @最后有效 adj_close=10.3。
    """

    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 10.2, "low": 9.5, "close": 10.0},
        {"trade_date": "20240102", "open": 10.0, "high": 10.2, "low": 9.99, "close": 10.1},
        {"trade_date": "20240103", "open": 10.1, "high": 10.3, "low": 10.05, "close": 10.2},
        {"trade_date": "20240104", "open": 10.2, "high": 10.4, "low": 10.15, "close": 10.3},
        {"trade_date": "20240105", "open": 10.3, "high": 10.5, "low": 10.25, "close": 10.4},
    ]
    delist = pd.DataFrame({"ts_code": ["X"], "delist_date": ["20240105"]})
    out = compute_phase_lock_labels(
        LabelInputs(
            daily_quotes=_quotes(rows),
            delist=delist,
            entries=_entries("20240101"),
            end="20240105",
        ),
        init_factor=0.999,
        lock_factor=0.999,
        lookback=3,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "force_close"
    # buy=open(T+1)=10.0；截断到 20240105 前 → 末日 20240104 adj_close=10.3。
    assert math.isclose(row["value"], 10.3 / 10.0 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 入场过滤：一字涨停买不进 → 无标签
# ----------------------------------------------------------------------

def test_limit_up_on_entry_no_label() -> None:
    """T+1 一字涨停（raw_open≥up_limit）→ 该信号不产生标签（entries 阶段已剔除）。"""

    rows = [
        {"trade_date": "20240101", "open": 9.9, "high": 10.0, "low": 9.7, "close": 9.95},
        # T+1 open=11.0 == up_limit → 一字涨停
        {"trade_date": "20240102", "open": 11.0, "high": 11.0, "low": 11.0, "close": 11.0},
        {"trade_date": "20240103", "open": 11.0, "high": 11.2, "low": 10.9, "close": 11.1},
    ]
    stk_limit = pd.DataFrame(
        [{"ts_code": "X", "trade_date": "20240102", "up_limit": 11.0, "down_limit": 8.9}]
    )
    out = compute_phase_lock_labels(
        LabelInputs(
            daily_quotes=_quotes(rows),
            stk_limit=stk_limit,
            entries=_entries("20240101"),
            end="20240103",
        ),
        init_factor=0.999,
        lock_factor=0.999,
        lookback=3,
    )
    # entries 阶段 derive_limit_up_set 剔除 → 无候选 → 空表
    assert out.empty


# ----------------------------------------------------------------------
# 左扩验证：recent_lows 用到 T+1 之前的左扩行（lookback>窗口起点可用行数）
# ----------------------------------------------------------------------

def test_left_extension_feeds_recent_lows() -> None:
    """recent_lows 切片消费 buy_date 之前的左扩 head 行（spec 03 §左扩取大）。

    构造：信号 T=20240104，T+1=20240105。前 4 根（20240101..0104）作左扩 + 信号日。
    lookback=4 → recent_lows = 含 T+1 的最近 4 根在场 low（含左扩行 20240102/0103）。
    令最低值落在某个左扩行（20240102 low=9.0）→ init_stop=floor2(9.0×1.0)=9.00，
    使 T+2 才在 low 8.9≤9.00 触发 → 证明 init_stop 取到了左扩行的 low（非仅 T/T+1）。
    """

    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 10.1, "low": 9.9, "close": 10.0},
        # 左扩最低行（low=9.0）—— recent_lows 必须取到它
        {"trade_date": "20240102", "open": 9.5, "high": 9.6, "low": 9.0, "close": 9.5},
        {"trade_date": "20240103", "open": 9.6, "high": 9.7, "low": 9.5, "close": 9.6},
        # 信号日 T
        {"trade_date": "20240104", "open": 9.7, "high": 9.8, "low": 9.6, "close": 9.7},
        # T+1 持仓首日（low 9.7 > 9.0）
        {"trade_date": "20240105", "open": 9.8, "high": 9.9, "low": 9.7, "close": 9.85},
        # T+2 low 8.9 ≤ init_stop 9.00 → 触发（只有 init_stop 取到左扩 9.0 才会触发）
        {"trade_date": "20240108", "open": 9.5, "high": 9.6, "low": 8.9, "close": 9.0},
        {"trade_date": "20240109", "open": 9.0, "high": 9.1, "low": 8.8, "close": 9.0},
    ]
    out = compute_phase_lock_labels(
        LabelInputs(daily_quotes=_quotes(rows), entries=_entries("20240104"), end="20240109"),
        init_factor=1.0,
        lock_factor=1.0,
        lookback=4,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "phase_lock_stop"
    # init_stop=floor2(min([9.0(0102),9.5(0103),9.6(0104),9.7(0105)])×1.0)=9.00。
    # T+2(20240108) low8.9≤9.00 触发，open9.5≥stop → fill=min(9.00,9.5)=9.00。
    # buy=open(T+1=20240105)=9.8 → value=9.00/9.8-1。
    assert math.isclose(row["value"], 9.00 / 9.8 - 1.0, rel_tol=1e-9)
    assert row["hold_days"] == 1


def test_lookback_too_small_misses_left_extension_low() -> None:
    """对照：lookback 太小 → recent_lows 取不到左扩最低行 → init_stop 不同（参数生效）。

    同 test_left_extension_feeds_recent_lows 的 quotes，但 lookback=2 →
    recent_lows = 含 T+1 的最近 2 根 [9.6(T=0104), 9.7(T+1=0105)] → min=9.6 →
    init_stop=floor2(9.6×1.0)=9.60。T+2 low8.9≤9.60 仍触发，但成交 fill=min(9.60,9.5)=9.50
    （open9.5<stop9.60 跳空低开取开盘）→ value=9.50/9.8-1，与 lookback=4 路径不同。
    证明 lookback 确实驱动 recent_lows 切片宽度（参数透传 + 切片口径正确）。
    """

    rows = [
        {"trade_date": "20240101", "open": 10.0, "high": 10.1, "low": 9.9, "close": 10.0},
        {"trade_date": "20240102", "open": 9.5, "high": 9.6, "low": 9.0, "close": 9.5},
        {"trade_date": "20240103", "open": 9.6, "high": 9.7, "low": 9.5, "close": 9.6},
        {"trade_date": "20240104", "open": 9.7, "high": 9.8, "low": 9.6, "close": 9.7},
        {"trade_date": "20240105", "open": 9.8, "high": 9.9, "low": 9.7, "close": 9.85},
        {"trade_date": "20240108", "open": 9.5, "high": 9.6, "low": 8.9, "close": 9.0},
        {"trade_date": "20240109", "open": 9.0, "high": 9.1, "low": 8.8, "close": 9.0},
    ]
    out = compute_phase_lock_labels(
        LabelInputs(daily_quotes=_quotes(rows), entries=_entries("20240104"), end="20240109"),
        init_factor=1.0,
        lock_factor=1.0,
        lookback=2,
    )
    assert len(out) == 1
    row = out.iloc[0]
    assert row["exit_reason"] == "phase_lock_stop"
    # init_stop=floor2(min(9.6,9.7))=9.60；T+2 open9.5<9.60 跳空 → fill=min(9.60,9.5)=9.50。
    assert math.isclose(row["value"], 9.50 / 9.8 - 1.0, rel_tol=1e-9)


# ----------------------------------------------------------------------
# 默认参数零漂移 + init/lock factor 透传
# ----------------------------------------------------------------------

def test_default_params_zero_drift() -> None:
    """3 个参数全默认 → 与显式传全默认值逐位一致（零漂移硬门）。"""

    from quant_pipeline.labels.phase_lock_scheme import (
        DEFAULT_INIT_FACTOR,
        DEFAULT_LOCK_FACTOR,
        DEFAULT_LOOKBACK,
    )

    rows = [
        {"trade_date": "20240101", "open": 9.6, "high": 9.7, "low": 9.5, "close": 9.6},
        {"trade_date": "20240102", "open": 10.0, "high": 10.1, "low": 9.5, "close": 10.0},
        {"trade_date": "20240103", "open": 9.6, "high": 9.7, "low": 9.4, "close": 9.45},
        {"trade_date": "20240104", "open": 9.4, "high": 9.5, "low": 9.3, "close": 9.4},
    ]
    quotes = _quotes(rows)
    base = compute_phase_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240104")
    )
    explicit = compute_phase_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240104"),
        init_factor=DEFAULT_INIT_FACTOR,
        lock_factor=DEFAULT_LOCK_FACTOR,
        lookback=DEFAULT_LOOKBACK,
    )
    pd.testing.assert_frame_equal(base, explicit)


def test_init_factor_passthrough_changes_exit() -> None:
    """收紧 init_factor（1.0→0.98）抬低初始止损基准 → 出场结果变化（参数确实透传到核）。

    recent_lows min=9.5；
      - init_factor=1.0  → init_stop=floor2(9.5)=9.50；
      - init_factor=0.98 → init_stop=floor2(9.5×0.98)=floor2(9.31)=9.31。
    T+2 low=9.40 → 在 9.50 下触发、在 9.31 下不触发 → 两路径结果不同。
    """

    rows = [
        {"trade_date": "20231230", "open": 10.0, "high": 10.1, "low": 9.8, "close": 9.9},
        {"trade_date": "20240101", "open": 9.6, "high": 9.7, "low": 9.5, "close": 9.6},
        {"trade_date": "20240102", "open": 10.0, "high": 10.1, "low": 9.5, "close": 10.0},
        {"trade_date": "20240103", "open": 9.6, "high": 9.7, "low": 9.40, "close": 9.45},
        {"trade_date": "20240104", "open": 9.5, "high": 9.6, "low": 9.45, "close": 9.5},
    ]
    quotes = _quotes(rows)
    loose = compute_phase_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240104"),
        init_factor=1.0,
        lock_factor=1.0,
        lookback=3,
    )
    tight = compute_phase_lock_labels(
        LabelInputs(daily_quotes=quotes, entries=_entries("20240101"), end="20240104"),
        init_factor=0.98,
        lock_factor=1.0,
        lookback=3,
    )
    assert len(loose) == 1 and len(tight) == 1
    # init_factor=1.0 → T+2 触止损；init_factor=0.98 → init_stop=9.31 不触 → 出场不同。
    assert (
        loose.iloc[0]["exit_reason"] != tight.iloc[0]["exit_reason"]
        or not math.isclose(
            loose.iloc[0]["value"], tight.iloc[0]["value"], rel_tol=1e-9
        )
        or loose.iloc[0]["hold_days"] != tight.iloc[0]["hold_days"]
    )
    # loose 路径明确：init_stop=9.50，T+2 low9.40≤9.50 触发。
    assert loose.iloc[0]["exit_reason"] == "phase_lock_stop"
    assert math.isclose(loose.iloc[0]["value"], 9.50 / 10.0 - 1.0, rel_tol=1e-9)
