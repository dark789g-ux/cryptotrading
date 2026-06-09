"""波段跟踪止损出场规则 trailing_lock —— 共享纯函数核（单一真值）。

⚠️ 本模块是「波段跟踪止损 trailing_lock」出场规则的**唯一行为真值**。
   规范算法见 docs/superpowers/specs/2026-06-09-trailing-lock-exit-design/
   01-rule-semantics.md（语义）+ 02-shared-core-and-contracts.md（接口 + 对拍样例）。
   后续会被 Python 的 exit_rules / kelly_sweep 复用，并有一个同构 TS 版做跨语言对拍——
   **任何偏差都会让对拍失败**，改动务必同步两边并重跑对拍样例 S1~S13。

核心约定（详见 spec）：
- 价格基准：核内统一用复权价 adj_*；限停板判定用未复权价 raw_* + up/down_limit。
- 信号 K 线 = T；持仓首日 = bars[0] = T+1，开盘买入；成本价 cost = adj_open(bars[0])；
  signal_high = adj_high(T)（由入参给）。
- 「次日 / 此后每个交易日」= 下一个可交易日（跳过停牌日）。停牌日不计 hold、不触发、
  不更新止损、不动 prev_ma5。`is_suspended or adj_close is None` 即视为停牌日。
- 止损价取整：floor2(x) = math.floor(x*100)/100，向下截断到 0.01；与 TS 版逐位一致。
- 核函数**不处理退市 / force_close / 数据末尾兜底**——窗口耗尽未出场返回 kind='no_exit'，
  交调用方收口（见 spec 01 §六）。

纯函数：不连 DB、不读文件、无副作用。
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

__all__ = [
    "BandLockBar",
    "BandLockOutcome",
    "floor2",
    "simulate_band_lock",
]


def floor2(x: float) -> float:
    """向下截断到 0.01（跨语言逐位一致）。

    统一先 x*100、math.floor、再 /100；**不要**用字符串截断。
    与 TS 版 `Math.floor(x*100)/100` 给出逐位相同结果（避免浮点末位差异导致对拍失败）。

    例：floor2(9.99)=9.99；floor2(10.4895)=10.48；floor2(10.567*0.999)=10.55。
    """

    return math.floor(x * 100) / 100


@dataclass(frozen=True)
class BandLockBar:
    """逐 bar 输入记录（持仓窗口，T+1 起升序，bars[0] = 持仓首日）。"""

    # —— 复权价(各模块基准)，停牌日全部为 None ——
    adj_open: float | None
    adj_high: float | None
    adj_low: float | None
    adj_close: float | None
    ma5: float | None  # 5 个非停牌交易日的复权收盘均值；预热不足为 None
    # —— 未复权价 + 限停板，用于流动性判定；缺失为 None(该端约束不生效) ——
    raw_open: float | None
    raw_high: float | None
    up_limit: float | None
    down_limit: float | None
    is_suspended: bool = False  # 冗余防御；停牌通常表现为 adj_* 为 None


@dataclass(frozen=True)
class BandLockOutcome:
    """simulate_band_lock 返回。"""

    kind: str  # 'no_entry' | 'exit' | 'no_exit'
    # no_entry: 'suspended'|'limit_up'；exit: 'stop'|'ma5_exit'|'max_hold'
    reason: str | None = None
    exit_index: int | None = None  # bars 下标(命中出场那根)
    exit_price: float | None = None  # 复权价
    scheme: int | None = None  # 1 | 2
    hold_days: int | None = None  # 已走过可交易持有日数(持仓首日=0，停牌不计)


def _is_suspended(bar: BandLockBar) -> bool:
    """停牌日：is_suspended 或 adj_close 为空（与 exit_rules 「停牌缺行被跳过」口径一致）。"""

    return bool(bar.is_suspended) or bar.adj_close is None


def _is_dead_limit_down(bar: BandLockBar) -> bool:
    """封死跌停（卖不出）：raw_high ≤ down_limit。

    down_limit 缺失（None）→ 该端约束不生效，视为可卖（非封死）。
    raw_high 缺失（None）→ 无从判定封板，保守视为可卖（不因缺数据误顺延）。
    """

    if bar.down_limit is None or bar.raw_high is None:
        return False
    return bar.raw_high <= bar.down_limit


def simulate_band_lock(
    bars: Sequence[BandLockBar],
    signal_high: float,
    *,
    max_hold: int | None = None,
) -> BandLockOutcome:
    """模拟波段跟踪止损出场（规范算法逐字实现，见模块 docstring 指向的 spec）。

    参数：
        bars:        持仓窗口，T+1 起升序；bars[0] = 持仓首日。
        signal_high: 信号 K 线 T 的复权最高价 adj_high(T)。
        max_hold:    可选硬上限（已走过可交易持有日数）；None = 不设硬上限（默认）。

    返回 BandLockOutcome：
        kind='no_entry'：买入端不成立（停牌 / 一字涨停）。
        kind='exit'    ：命中 stop / ma5_exit / max_hold；字段齐全。
        kind='no_exit' ：窗口耗尽未出场（含顺延未解），调用方按各自终止口径收口。
    """

    if not bars:
        return BandLockOutcome(kind="no_exit")

    entry = bars[0]

    # ---- 入场（bars[0] = 持仓首日 T+1） ----
    # 停牌 / 无 quote → 信号不成立
    if _is_suspended(entry) or entry.adj_open is None:
        return BandLockOutcome(kind="no_entry", reason="suspended")
    # 一字涨停买不进 = raw_open ≥ up_limit（仅入场端；up_limit 非空才生效）
    if (
        entry.up_limit is not None
        and entry.raw_open is not None
        and entry.raw_open >= entry.up_limit
    ):
        return BandLockOutcome(kind="no_entry", reason="limit_up")

    cost = entry.adj_open
    # 方案 1：持仓首日 close > open；否则方案 2
    scheme = 1 if (entry.adj_close is not None and entry.adj_close > entry.adj_open) else 2

    # 持仓首日"收盘后"设定、T+2 生效的初始止损
    if scheme == 1:
        stop_next: float | None = floor2(entry.adj_open * 0.999)
    else:
        # 方案二初始止损用 adj_low；adj_low 缺失则退回 adj_open（防御，正常数据不缺）
        base_low = entry.adj_low if entry.adj_low is not None else entry.adj_open
        stop_next = floor2(base_low * 0.999)

    locked = False
    floor_active = False
    pending: str | None = None
    hold = 0
    prev_ma5 = entry.ma5

    floor_price = floor2(cost * 0.999)  # 方案二保本地板价（常量）

    # ---- 逐日推进（i = 1, 2, …） ----
    for i in range(1, len(bars)):
        bar = bars[i]

        # 先判停牌：不计 hold / 不触发 / 不更新止损 / 不动 prev_ma5
        if _is_suspended(bar):
            continue

        hold += 1
        stop_eff = stop_next  # 今日生效 = 昨日收盘设定的

        dead_limit_down = _is_dead_limit_down(bar)

        # (0) 顺延中（pending ≠ None）
        if pending is not None:
            if not dead_limit_down:
                # 非封死跌停 → 出场 @adj_open，reason 保留
                return BandLockOutcome(
                    kind="exit",
                    reason=pending,
                    exit_index=i,
                    exit_price=bar.adj_open,
                    scheme=scheme,
                    hold_days=hold,
                )
            # 仍封死 → 继续顺延
            continue

        # (1) 日内止损
        if stop_eff is not None and bar.adj_low is not None and bar.adj_low <= stop_eff:
            if dead_limit_down:
                # 封死跌停卖不出 → 置 pending，顺延
                pending = "stop"
                continue
            # 跳空低开（open < stop）按开盘价成交 → 取 min(stop_eff, adj_open)
            fill = min(stop_eff, bar.adj_open) if bar.adj_open is not None else stop_eff
            return BandLockOutcome(
                kind="exit",
                reason="stop",
                exit_index=i,
                exit_price=fill,
                scheme=scheme,
                hold_days=hold,
            )

        # (2) 收盘处理（未被止损）
        # (2-pre) 方案二保本地板激活（每个交易日都评估，含锁定当日；sticky）
        if scheme == 2 and bar.adj_close is not None and bar.adj_close > cost:
            floor_active = True

        # (2a) 未锁定 且 adj_low > signal_high → 锁定
        if not locked and bar.adj_low is not None and bar.adj_low > signal_high:
            stop_next = floor2(bar.adj_low * 0.999)
            if scheme == 2 and floor_active:
                stop_next = max(stop_next, floor_price)
            locked = True  # 从此冻结，stop_next 不再更新

        if locked:
            # (2b) 已锁定（含本日刚锁定）→ MA5 收盘离场
            if (
                bar.ma5 is not None
                and prev_ma5 is not None
                and bar.adj_close is not None
                and bar.adj_close < bar.ma5
                and bar.ma5 < prev_ma5
            ):
                if dead_limit_down:
                    # 封死跌停 → 置 pending，顺延（本日不再评估 max_hold）
                    pending = "ma5_exit"
                    prev_ma5 = bar.ma5
                    continue
                return BandLockOutcome(
                    kind="exit",
                    reason="ma5_exit",
                    exit_index=i,
                    exit_price=bar.adj_close,
                    scheme=scheme,
                    hold_days=hold,
                )
        else:
            # (2c) 未锁定 → 更新次日止损 stop_next
            if bar.adj_low is not None:
                low_stop = floor2(bar.adj_low * 0.999)
                if scheme == 2 and floor_active:
                    stop_next = max(low_stop, floor_price)
                else:
                    stop_next = low_stop
            # adj_low 缺失（停牌已被上面跳过，这里基本不会发生）→ 保持 stop_next 不变

        # (2d) max_hold 兜底
        if max_hold is not None and hold >= max_hold:
            return BandLockOutcome(
                kind="exit",
                reason="max_hold",
                exit_index=i,
                exit_price=bar.adj_close,
                scheme=scheme,
                hold_days=hold,
            )

        prev_ma5 = bar.ma5

    # 窗口耗尽未出场（含顺延未解）→ no_exit
    return BandLockOutcome(kind="no_exit")
