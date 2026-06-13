"""阶段锁定出场规则 phase_lock —— 共享纯函数核（单一真值）。

⚠️ 本模块是「阶段锁定 phase_lock」出场规则的**唯一行为真值**，也是整个特性的
   **数值权威源**：后续 TS 同构版（decidePhaseLock / simulateTradeCore phase_lock 分支）
   逐数值镜像本模块测试 test_phase_lock_exit.py 的期望，**任何偏差都会让跨语言对拍失败**。
   规范算法见 docs/superpowers/specs/2026-06-13-phase-lock-exit-design/
   01-algorithm.md（语义）+ 03-python-core-and-labels.md（接口）+ 06-fixtures-and-testing.md（对拍样例）。

两阶段状态机（与 band_lock「逐日跟踪上移」不同——见关键差异 §1）：
- **阶段 A（初始止损固定）**：建仓 T+1 开盘买入，cost = adj_open(T+1)。
  初始止损 = floor2( min(含 T+1 的最近 lookback 根非停牌复权 low) × init_factor )，
  **固定不上移**（这是与 band_lock 最大差异：band_lock 未锁定时每日用当日 low 抬升止损）。
- **阶段切换（仅一次）**：收盘 close > MA5 且 MA5 > 前一非停牌日 MA5 → 上移止损并冻结、进入阶段 B。
  新止损 = floor2( max(cost, 当日 low) × lock_factor )，**次日**盘中生效。
- **阶段 B（止损冻结）**：收盘 close < MA5 且 MA5 < 前一非停牌日 MA5 → 按收盘价清仓（phase_lock_ma5）。
- **盘中止损全程优先**：任意阶段当日 adj_low ≤ 当日生效止损 → phase_lock_stop（跳空低开取开盘价）。

核心约定（详见 spec）：
- 价格基准：核内统一用复权价 adj_*；限停板判定用未复权价 raw_* + up/down_limit。
- 信号 K 线 = T；持仓首日 = bars[0] = T+1，开盘买入；成本价 cost = adj_open(bars[0])。
- recent_lows = 含 T+1 的最近 lookback 个**非停牌**复权 low（按时间升序，**由数据层切好**传入，
  类比 band_lock 传 signal_high）。core **不**自己读 lookback 之外历史（保持纯）；不足 lookback
  根 → 用现有可用根数（至少含 T+1），不报错；空（理论不会）→ 视为无初始止损。
- 「次日 / 此后每个交易日」= 下一个可交易日（跳过停牌日）。停牌日不计 hold、不触发、
  不更新止损、不动 prev_ma5。`is_suspended or adj_close is None` 即视为停牌日。
- 止损价取整：floor2(x) = math.floor(x*100)/100，向下截断到 0.01；与 TS 版逐位一致。
- 核函数**不处理退市 / force_close / 数据末尾兜底 / max_hold**——窗口耗尽未出场返回
  kind='no_exit'，交调用方收口。固定 ma5_require_down=True、ma5_require_up=True、无 max_hold。

纯函数：不连 DB、不读文件、无副作用。
"""

from __future__ import annotations

import math
from collections.abc import Sequence
from dataclasses import dataclass

__all__ = [
    "DEFAULT_INIT_FACTOR",
    "DEFAULT_LOCK_FACTOR",
    "DEFAULT_LOOKBACK",
    "PhaseLockBar",
    "PhaseLockOutcome",
    "floor2",
    "simulate_phase_lock",
]

# 模块级默认常量 —— 本模块是这三个默认的**唯一权威源**
#（scheme / labels / kelly / 数据层都将引用它，与 band_lock_exit.py 持有核默认同理）。
DEFAULT_INIT_FACTOR = 0.999
DEFAULT_LOCK_FACTOR = 0.999
DEFAULT_LOOKBACK = 10


def floor2(x: float) -> float:
    """向下截断到 0.01（跨语言逐位一致）。

    统一先 x*100、math.floor、再 /100；**不要**用字符串截断。
    与 TS 版 `Math.floor(x*100)/100` 给出逐位相同结果（避免浮点末位差异导致对拍失败）。

    例：floor2(9.99)=9.99；floor2(10.4895)=10.48；floor2(10.567*0.999)=10.55。
    """

    return math.floor(x * 100) / 100


@dataclass(frozen=True)
class PhaseLockBar:
    """逐 bar 输入记录（持仓窗口，T+1 起升序，bars[0] = 持仓首日）。

    字段对齐 BandLockBar；停牌日复权价全部为 None。
    """

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
class PhaseLockOutcome:
    """simulate_phase_lock 返回。"""

    kind: str  # 'no_entry' | 'exit' | 'no_exit'
    # no_entry: 'suspended'|'limit_up'；exit: 'phase_lock_stop'|'phase_lock_ma5'
    reason: str | None = None
    exit_index: int | None = None  # bars 下标(命中出场那根)
    exit_price: float | None = None  # 复权价
    hold_days: int = 0  # 已走过可交易持有日数(持仓首日不计；停牌不计)
    locked: bool = False  # 是否曾进入阶段 B（调试/统计用）


def _is_suspended(bar: PhaseLockBar) -> bool:
    """停牌日：is_suspended 或 adj_close 为空（与 exit_rules 「停牌缺行被跳过」口径一致）。"""

    return bool(bar.is_suspended) or bar.adj_close is None


def _is_dead_limit_down(bar: PhaseLockBar) -> bool:
    """封死跌停（卖不出）：raw_high ≤ down_limit。

    down_limit 缺失（None）→ 该端约束不生效，视为可卖（非封死）。
    raw_high 缺失（None）→ 无从判定封板，保守视为可卖（不因缺数据误顺延）。
    """

    if bar.down_limit is None or bar.raw_high is None:
        return False
    return bar.raw_high <= bar.down_limit


def simulate_phase_lock(
    bars: Sequence[PhaseLockBar],
    recent_lows: Sequence[float],
    init_factor: float = DEFAULT_INIT_FACTOR,
    lock_factor: float = DEFAULT_LOCK_FACTOR,
) -> PhaseLockOutcome:
    """模拟阶段锁定出场（规范算法逐字实现，见模块 docstring 指向的 spec）。

    参数：
        bars:        持仓窗口，T+1 起升序；bars[0] = 持仓首日。
        recent_lows: 含 T+1 的最近 lookback 个**非停牌**复权 low（升序，**数据层切好**）。
                     core 只做 min × init_factor，不消费 lookback（切片是数据层的事）。
                     不足 lookback 根 → 用现有可用根数；空（理论不会）→ 无初始止损。
        init_factor: 初始止损系数（仅作用于初始止损，× min(recent_lows)），默认 0.999。
        lock_factor: 锁定止损系数（仅作用于锁定止损，× max(cost, 当日 low)），默认 0.999。
                     init_factor / lock_factor **互不串用**。

    返回 PhaseLockOutcome：
        kind='no_entry'：买入端不成立（停牌 / 涨停开盘）。
        kind='exit'    ：命中 phase_lock_stop / phase_lock_ma5；字段齐全。
        kind='no_exit' ：窗口耗尽未出场（含顺延未解），调用方按各自终止口径收口。
    """

    if not bars:
        return PhaseLockOutcome(kind="no_exit")

    entry = bars[0]

    # ---- 入场（bars[0] = 持仓首日 T+1） ----
    # 停牌 / 无 quote → 信号不成立
    if _is_suspended(entry) or entry.adj_open is None:
        return PhaseLockOutcome(kind="no_entry", reason="suspended")
    # 涨停开盘不入场 = raw_open ≥ up_limit（仅入场端；两者非空才生效）
    if (
        entry.up_limit is not None
        and entry.raw_open is not None
        and entry.raw_open >= entry.up_limit
    ):
        return PhaseLockOutcome(kind="no_entry", reason="limit_up")

    cost = entry.adj_open

    # 阶段 A 初始止损（固定，不上移）：min(recent_lows) × init_factor。
    # recent_lows 已由数据层切好；不足 lookback 根 → 用现有；空 → 无初始止损（None）。
    init_stop: float | None = None if not recent_lows else floor2(min(recent_lows) * init_factor)

    stop_next: float | None = init_stop  # T+2 起盘中生效（持仓首日 T+1 不出场）
    locked = False
    pending: str | None = None
    hold = 0
    prev_ma5 = entry.ma5

    # ---- 逐日推进（i = 1, 2, …） ----
    for i in range(1, len(bars)):
        bar = bars[i]

        # 先判停牌：不计 hold / 不触发 / 不更新止损 / 不动 prev_ma5
        if _is_suspended(bar):
            continue

        hold += 1
        stop_eff = stop_next  # 今日生效 = 昨日收盘设定的（阶段切换当日设的新止损次日才进这里）

        dead_limit_down = _is_dead_limit_down(bar)

        # (0) 顺延中（上日封死跌停未能出场）
        if pending is not None:
            if not dead_limit_down:
                # 非封死跌停 → 出场 @adj_open，reason 保留
                return PhaseLockOutcome(
                    kind="exit",
                    reason=pending,
                    exit_index=i,
                    exit_price=bar.adj_open,
                    hold_days=hold,
                    locked=locked,
                )
            # 仍封死 → 继续顺延
            continue

        # (1) 盘中止损 [最高优先]
        if stop_eff is not None and bar.adj_low is not None and bar.adj_low <= stop_eff:
            if dead_limit_down:
                # 封死跌停卖不出 → 置 pending，顺延
                pending = "phase_lock_stop"
                continue
            # 跳空低开（open < stop）按开盘价成交 → 取 min(stop_eff, adj_open)
            fill = min(stop_eff, bar.adj_open) if bar.adj_open is not None else stop_eff
            return PhaseLockOutcome(
                kind="exit",
                reason="phase_lock_stop",
                exit_index=i,
                exit_price=fill,
                hold_days=hold,
                locked=locked,
            )

        # (2) 收盘判断（当日未触止损）
        if not locked:
            # 阶段切换：close > MA5 且 MA5 > prev_ma5（ma5_require_up 钉死 True），仅一次。
            # 切换当日设的新止损**次日生效**（当日已过盘中止损检查）；切换日不评估清仓。
            if (
                bar.ma5 is not None
                and prev_ma5 is not None
                and bar.adj_close is not None
                and bar.adj_close > bar.ma5
                and bar.ma5 > prev_ma5
            ):
                # max(cost, 当日 low)；adj_low 缺失（停牌已跳过，正常不发生）退回 cost
                base = max(cost, bar.adj_low) if bar.adj_low is not None else cost
                stop_next = floor2(base * lock_factor)  # 上移并冻结
                locked = True
            # 否则：stop_next 保持初始值不变（阶段 A 固定——与 band_lock 逐日上移的关键差异！）
        else:
            # 阶段 B：清仓 close < MA5 且 MA5 < prev_ma5（ma5_require_down 钉死 True）
            if (
                bar.ma5 is not None
                and bar.adj_close is not None
                and bar.adj_close < bar.ma5
                and prev_ma5 is not None
                and bar.ma5 < prev_ma5
            ):
                if dead_limit_down:
                    # 封死跌停卖不出 → 置 pending，顺延（prev_ma5 仍照常推进）
                    pending = "phase_lock_ma5"
                    prev_ma5 = bar.ma5
                    continue
                return PhaseLockOutcome(
                    kind="exit",
                    reason="phase_lock_ma5",
                    exit_index=i,
                    exit_price=bar.adj_close,
                    hold_days=hold,
                    locked=locked,
                )
            # 否则：止损冻结，stop_next 不变

        prev_ma5 = bar.ma5

    # 窗口耗尽未出场（含顺延未解）→ no_exit
    return PhaseLockOutcome(kind="no_exit", locked=locked, hold_days=hold)
