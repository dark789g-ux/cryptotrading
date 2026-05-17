# -*- coding: utf-8 -*-
"""A 股 daily 频出场规则模块。

⚠️ 此模块定义 A 股 daily 频出场规则，必须同时被本模块 (labels) 与未来回测引擎复用。
   任何修改务必同步评估对训练标签 / 回测真实 P&L 的影响。
   见 spec 05-risks.md §2 + doc/量化/04-标签设计.md §4.2。

设计原则：
1. 规则采用 ExitRule(ABC) → decide(state) 抽象基类形式，每条规则一个独立类。
   - MA5BreakRule        收盘跌破 MA5 出场
   - StopLossRule(-0.08) 当日 low_price 触及 -8% 强制止损（按 stop_price 出）
   - MaxHoldRule(20)     持仓达上限强制平仓
2. combine_rules() 提供 first-match 复合规则：按列表顺序，命中即返回。
3. simulate_exit() 模拟从 buy_date 持仓到出场，处理：
   - 停牌：持仓挂起，hold_days 不递增，不触发规则
   - 退市 / 数据末尾：强制平仓 force_close
   - 涨跌停（is_limit_up / is_limit_down）：调用方在标签层处理"出场日涨跌停顺延"，
     本模块只在 ExitDecision 层提供 limit-aware 的次日成交建议（pending_exit）。
4. 纯函数 / 纯类，不依赖 SQLAlchemy / IO；labels.runner 层负责 DB 接触。

接口契约：
    simulate_exit(buy_date, ts_code, prices_df, rules,
                  *, suspend_dates=None, force_close_date=None) -> ExitOutcome | None
"""

from __future__ import annotations

from abc import ABC, abstractmethod
from collections.abc import Iterable, Sequence
from dataclasses import dataclass
from typing import Final

import numpy as np
import pandas as pd

# ---- 规则常量（与 doc/量化/04 §4.2.3 一致；改动需同步 spec） ----
STOP_LOSS_THRESHOLD: Final[float] = -0.08
MAX_HOLD_DAYS: Final[int] = 20
MA_WINDOW: Final[int] = 5

# 出场原因常量（外部依赖此字符串字面量，回测引擎也会读，禁止随意改名）
EXIT_BELOW_MA5: Final[str] = "ma5_break"
EXIT_STOP_LOSS: Final[str] = "stop_loss"
EXIT_MAX_HOLD: Final[str] = "max_hold"
EXIT_FORCE_CLOSE: Final[str] = "force_close"


# ----------------------------------------------------------------------
# 状态 + 决策数据结构（dataclass，回测引擎可直接复用）
# ----------------------------------------------------------------------

@dataclass(frozen=True)
class ExitState:
    """单日决策上下文。回测引擎按日驱动，每日构造一个 ExitState 传给规则。

    所有字段都来自当日 raw 数据 + 持仓元数据；不依赖 DB / SQLAlchemy。
    """

    entry_date: str
    current_date: str
    entry_price: float
    current_price: float           # 当日 close（含复权）
    low_price: float               # 当日 low（含复权）—— 用于止损穿透判断
    ma5: float                     # 当日 MA5（含复权 close 滚动 5 日均值）
    hold_days: int                 # 含当日在内的已持有交易日数（停牌日不计）
    is_suspended: bool             # 当日是否停牌
    is_limit_up: bool              # 当日是否涨停（出场日如涨停 → 卖不出，调用方顺延）
    is_limit_down: bool            # 当日是否跌停
    is_delisted: bool              # 当日是否退市


@dataclass(frozen=True)
class ExitDecision:
    """一条规则触发的出场决策。"""

    exit_reason: str
    exit_price: float              # 建议成交价（止损用 stop_price；其它用 close）


@dataclass(frozen=True)
class ExitOutcome:
    """simulate_exit 单笔模拟结果。"""

    ts_code: str
    entry_date: str
    exit_date: str
    exit_price: float
    exit_reason: str
    hold_days: int


# ----------------------------------------------------------------------
# 抽象规则
# ----------------------------------------------------------------------

class ExitRule(ABC):
    """出场规则抽象基类。

    子类必须实现 decide(state) -> ExitDecision | None。
    返回 None 表示当日不触发；返回 ExitDecision 表示触发并给出价格。
    """

    name: str = ""

    @abstractmethod
    def decide(self, state: ExitState) -> ExitDecision | None:
        """对当日状态做决策。停牌 / 退市等由 simulate_exit 拦截，规则不需处理。"""


class MA5BreakRule(ExitRule):
    """收盘跌破 MA5 出场（doc/04 §4.2.3 规则 1）。

    出场价：当日 close。
    MA5 不足 5 日有效数据时不触发。
    """

    name = "ma5_break"

    def decide(self, state: ExitState) -> ExitDecision | None:
        if not np.isfinite(state.ma5):
            return None
        if state.current_price < state.ma5:
            return ExitDecision(
                exit_reason=EXIT_BELOW_MA5,
                exit_price=float(state.current_price),
            )
        return None


class StopLossRule(ExitRule):
    """强制止损：当日最低价相对入场价跌幅 ≤ threshold（默认 -0.08）即触发。

    出场价 = 触发价（entry_price * (1 + threshold)），假设按 stop 触发价成交，
    若当日 open 已低于 stop（跳空向下），按 open 成交（即取 min(stop, open)）。
    回测引擎接入时可以替换为"次日 VWAP"语义；本模块给出最朴素的 stop fill。
    """

    name = "stop_loss"

    def __init__(self, threshold: float = STOP_LOSS_THRESHOLD) -> None:
        if threshold >= 0:
            raise ValueError(f"StopLossRule threshold 必须 < 0，got {threshold}")
        self.threshold = float(threshold)

    def decide(self, state: ExitState) -> ExitDecision | None:
        if not np.isfinite(state.low_price) or not np.isfinite(state.entry_price):
            return None
        stop_price = float(state.entry_price) * (1.0 + self.threshold)
        if state.low_price <= stop_price:
            # 取 min(stop_price, low_price) 作为成交价（跳空向下按 low 成交）
            fill = min(stop_price, float(state.low_price))
            return ExitDecision(
                exit_reason=EXIT_STOP_LOSS,
                exit_price=fill,
            )
        return None


class MaxHoldRule(ExitRule):
    """持有满 max_days 个交易日强制平仓（doc/04 §4.2.3 规则 3）。

    出场价：当日 close。
    """

    name = "max_hold"

    def __init__(self, max_days: int = MAX_HOLD_DAYS) -> None:
        if max_days <= 0:
            raise ValueError(f"MaxHoldRule max_days 必须 > 0，got {max_days}")
        self.max_days = int(max_days)

    def decide(self, state: ExitState) -> ExitDecision | None:
        if state.hold_days >= self.max_days:
            return ExitDecision(
                exit_reason=EXIT_MAX_HOLD,
                exit_price=float(state.current_price),
            )
        return None


class _CombinedRule(ExitRule):
    """first-match 复合规则。"""

    name = "combined"

    def __init__(self, rules: Sequence[ExitRule]) -> None:
        if not rules:
            raise ValueError("combine_rules: rules 不能为空")
        self.rules: tuple[ExitRule, ...] = tuple(rules)

    def decide(self, state: ExitState) -> ExitDecision | None:
        for rule in self.rules:
            decision = rule.decide(state)
            if decision is not None:
                return decision
        return None


def combine_rules(rules: Sequence[ExitRule]) -> ExitRule:
    """first-match 复合规则：按列表顺序遍历，命中即返回。

    推荐顺序（与 doc/04 §4.2.3 一致）：止损 > MA5 出场 > 最大持有期。
    """

    return _CombinedRule(rules)


def default_rules() -> ExitRule:
    """labels.strategy_aware 与回测引擎共用的默认复合规则。"""

    return combine_rules(
        [
            StopLossRule(STOP_LOSS_THRESHOLD),
            MA5BreakRule(),
            MaxHoldRule(MAX_HOLD_DAYS),
        ]
    )


# ----------------------------------------------------------------------
# 模拟器
# ----------------------------------------------------------------------

_REQUIRED_PRICE_COLS: Final[tuple[str, ...]] = ("trade_date", "close")


def _ensure_ma5(prices_df: pd.DataFrame) -> pd.DataFrame:
    """若缺 ma5 列，按 trade_date 顺序滚动 5 日 close 均值补齐。

    注：调用方应传入"单一 ts_code、按日升序"的 prices_df。
    """

    if "ma5" in prices_df.columns:
        return prices_df
    out = prices_df.copy()
    out = out.sort_values("trade_date").reset_index(drop=True)
    out["ma5"] = out["close"].rolling(MA_WINDOW, min_periods=MA_WINDOW).mean()
    return out


def _normalize_prices(prices_df: pd.DataFrame) -> pd.DataFrame:
    """补齐 low / is_suspended / is_limit_up / is_limit_down / is_delisted 等可选列。

    缺失语义：
        low                 → 默认等于 close（无穿透检测能力，stop 退化为 close 比对）
        is_suspended        → False
        is_limit_up / down  → False
        is_delisted         → False
    """

    missing = [c for c in _REQUIRED_PRICE_COLS if c not in prices_df.columns]
    if missing:
        raise ValueError(f"prices_df 缺列 {missing}，必须含 {_REQUIRED_PRICE_COLS}")

    out = prices_df.copy()
    out["trade_date"] = out["trade_date"].astype(str)
    if "low" not in out.columns:
        out["low"] = out["close"]
    for col, default in (
        ("is_suspended", False),
        ("is_limit_up", False),
        ("is_limit_down", False),
        ("is_delisted", False),
    ):
        if col not in out.columns:
            out[col] = default
        else:
            # 列存在但行级缺失 → 填充默认值（避免 bool(NaN)=True 的坑）
            out[col] = out[col].fillna(default).astype(bool)
    out = out.sort_values("trade_date").reset_index(drop=True)
    return out


def simulate_exit(
    buy_date: str,
    ts_code: str,
    prices_df: pd.DataFrame,
    rules: ExitRule | Sequence[ExitRule],
    *,
    force_close_date: str | None = None,
) -> ExitOutcome | None:
    """模拟从 buy_date 持仓到出场。

    参数：
        buy_date:         入场日 YYYYMMDD（本函数把 buy_date 当日的 close 视为入场价）
        ts_code:          股票代码
        prices_df:        单只票按日升序的 DataFrame；必须含 [trade_date, close]，
                          可选 [low, ma5, is_suspended, is_limit_up, is_limit_down,
                          is_delisted]
        rules:            ExitRule 实例，或多条 ExitRule 的 sequence（自动 combine）
        force_close_date: 退市公告日 / 数据末尾等外部强制平仓日（YYYYMMDD）；
                          当 current_date >= force_close_date 时按当日 close 强平。

    返回：
        ExitOutcome 或 None（无法形成有效交易，如入场日不在数据中）。

    停牌处理：
        持仓期内 is_suspended=True 的交易日，hold_days 不递增、规则不触发，
        相当于"等复牌"。若停牌连续到 force_close_date / 数据末尾，由
        force_close / data-end 分支兜底（exit_reason=force_close）。

    涨跌停处理：
        当日规则触发但 is_limit_down=True → 真实卖单挂跌停板，本模块退化为
        "按 close 出场"并保留 reason；调用方（labels 层）可识别 limit-aware
        语义并把 exit 顺延到下一日（见 labels/strategy_aware.handle_limit_*）。
    """

    if isinstance(rules, ExitRule):
        rule = rules
    else:
        rule = combine_rules(list(rules))

    prices = _normalize_prices(prices_df)
    prices = _ensure_ma5(prices)

    # 切到 buy_date 起
    sub = prices[prices["trade_date"] >= str(buy_date)].reset_index(drop=True)
    if sub.empty or str(sub.iloc[0]["trade_date"]) != str(buy_date):
        return None
    entry_row = sub.iloc[0]
    if bool(entry_row["is_suspended"]) or bool(entry_row["is_delisted"]):
        return None
    entry_price = float(entry_row["close"])
    if not np.isfinite(entry_price) or entry_price <= 0:
        return None

    hold_days = 0
    # 从入场日次日开始决策
    for i in range(1, len(sub)):
        row = sub.iloc[i]
        td = str(row["trade_date"])

        # 退市：强制平仓（按当日 close，若 close NaN 按入场价兜底）
        if bool(row["is_delisted"]):
            close_val = float(row["close"]) if np.isfinite(float(row["close"])) else entry_price
            return ExitOutcome(
                ts_code=ts_code,
                entry_date=str(buy_date),
                exit_date=td,
                exit_price=close_val,
                exit_reason=EXIT_FORCE_CLOSE,
                hold_days=hold_days,
            )

        # 外部强制平仓（如标签层探测到的退市公告日）
        if force_close_date is not None and td >= str(force_close_date):
            close_val = float(row["close"]) if np.isfinite(float(row["close"])) else entry_price
            return ExitOutcome(
                ts_code=ts_code,
                entry_date=str(buy_date),
                exit_date=td,
                exit_price=close_val,
                exit_reason=EXIT_FORCE_CLOSE,
                hold_days=hold_days,
            )

        # 停牌：挂起，不递增 hold_days，不触发规则
        if bool(row["is_suspended"]):
            continue

        hold_days += 1

        close_val = float(row["close"])
        if not np.isfinite(close_val):
            # 数据缺失视为强制平仓
            return ExitOutcome(
                ts_code=ts_code,
                entry_date=str(buy_date),
                exit_date=td,
                exit_price=entry_price,
                exit_reason=EXIT_FORCE_CLOSE,
                hold_days=hold_days,
            )
        low_val = float(row["low"]) if np.isfinite(float(row["low"])) else close_val
        ma5_val = float(row["ma5"]) if pd.notna(row["ma5"]) else np.nan

        state = ExitState(
            entry_date=str(buy_date),
            current_date=td,
            entry_price=entry_price,
            current_price=close_val,
            low_price=low_val,
            ma5=ma5_val,
            hold_days=hold_days,
            is_suspended=False,
            is_limit_up=bool(row["is_limit_up"]),
            is_limit_down=bool(row["is_limit_down"]),
            is_delisted=False,
        )

        decision = rule.decide(state)
        if decision is None:
            continue

        # 出场日跌停 → 卖不出，顺延到下一可成交日（非跌停 / 非停牌）
        if state.is_limit_down:
            fallback = _find_first_tradable(sub, start_idx=i + 1)
            if fallback is None:
                # 数据末尾仍跌停 → force_close 按当前 close 兜底
                return ExitOutcome(
                    ts_code=ts_code,
                    entry_date=str(buy_date),
                    exit_date=td,
                    exit_price=close_val,
                    exit_reason=EXIT_FORCE_CLOSE,
                    hold_days=hold_days,
                )
            fallback_row = sub.iloc[fallback]
            return ExitOutcome(
                ts_code=ts_code,
                entry_date=str(buy_date),
                exit_date=str(fallback_row["trade_date"]),
                exit_price=float(fallback_row["close"]),
                exit_reason=decision.exit_reason,
                hold_days=hold_days,
            )

        return ExitOutcome(
            ts_code=ts_code,
            entry_date=str(buy_date),
            exit_date=td,
            exit_price=float(decision.exit_price),
            exit_reason=decision.exit_reason,
            hold_days=hold_days,
        )

    # 数据末尾未触发任何规则：force_close 按最后一日 close
    if len(sub) > 1:
        last_row = sub.iloc[-1]
        last_close = float(last_row["close"]) if np.isfinite(float(last_row["close"])) else entry_price
        return ExitOutcome(
            ts_code=ts_code,
            entry_date=str(buy_date),
            exit_date=str(last_row["trade_date"]),
            exit_price=last_close,
            exit_reason=EXIT_FORCE_CLOSE,
            hold_days=hold_days,
        )
    return None


def _find_first_tradable(sub: pd.DataFrame, *, start_idx: int) -> int | None:
    """从 start_idx 起找第一个非停牌、非跌停的行下标；找不到返回 None。"""

    for j in range(start_idx, len(sub)):
        row = sub.iloc[j]
        if bool(row["is_suspended"]):
            continue
        if bool(row["is_limit_down"]):
            continue
        if not np.isfinite(float(row["close"])):
            continue
        return j
    return None


__all__ = [
    # 抽象 + 实现
    "ExitRule",
    "MA5BreakRule",
    "StopLossRule",
    "MaxHoldRule",
    "combine_rules",
    "default_rules",
    # 状态 / 决策 / 结果
    "ExitState",
    "ExitDecision",
    "ExitOutcome",
    # 模拟器
    "simulate_exit",
    # 常量
    "STOP_LOSS_THRESHOLD",
    "MAX_HOLD_DAYS",
    "MA_WINDOW",
    "EXIT_BELOW_MA5",
    "EXIT_STOP_LOSS",
    "EXIT_MAX_HOLD",
    "EXIT_FORCE_CLOSE",
]
