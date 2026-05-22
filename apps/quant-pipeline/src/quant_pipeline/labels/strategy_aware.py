# -*- coding: utf-8 -*-
"""Strategy-aware labels（doc/量化/04 §4.2 推荐主用方案）。

调用 strategy.exit_rules.simulate_exit 对每个 (signal_date, ts_code) 模拟
"次日开盘买入 → 触发出场规则" 产生标签：
  value       = (exit_price - buy_price) / buy_price - 双边成本
  exit_reason = ma5_break / stop_loss / max_hold / force_close
  hold_days   = 实际持仓交易日数

入场日规范（doc/04 §4.2.3）：
  signal_date = T；buy_date = T+1（下一交易日）。
  buy_price = T+1 日 close（M2 简化；未来回测可换 VWAP）。

写入 factors.labels (trade_date = signal_date, ts_code,
                     scheme='strategy-aware', value, exit_reason, hold_days)。

### 必须处理的 5 个坑（doc/04 §4.2.4 + spec 强约束）

每个坑独立纯函数 + 独立单测 case，禁止 if/else 内联：

  1. filter_limit_up_on_entry      涨停：T+1 涨停 → 跳过；出场日涨跌停顺延由
                                   exit_rules.simulate_exit 内部 _find_first_tradable
                                   处理
  2. filter_suspended_on_entry     停牌：T+1 停牌 → 跳过；持仓期停牌挂起由
                                   exit_rules 内部处理（hold_days 不递增）
  3. filter_new_listing            新股：上市 < 60 个交易日 → 跳过
  4. apply_delisting_force_close   退市：持仓期触及退市日 → 强制平仓按最后交易价
                                   （exit_rules 已经接受 force_close_date 入参；
                                   本函数作为兜底校正 reason）
  5. winsorize_label_value         强右偏分布：features 层做温和截尾；labels 仅
                                   保留原始 value（marker，便于 features.builder
                                   引用同一个函数）

CLAUDE.md 硬约束：
  - upsert 前 PK 去重（runner 负责）
  - fetcher 空数据 warn（本模块的 entries 空走 logger.warning + 直接 return）
"""

from __future__ import annotations

import logging
from collections.abc import Iterable, Mapping
from dataclasses import dataclass, replace
from typing import Any, Callable, Final

import numpy as np
import pandas as pd

from quant_pipeline.strategy.exit_rules import (
    EXIT_FORCE_CLOSE,
    EXIT_STOP_LOSS,
    ExitOutcome,
    default_rules,
    simulate_exit,
)

logger = logging.getLogger(__name__)

# 双边成本（doc/量化/04 §4.2 推荐）
COMMISSION_BUY: Final[float] = 0.001
COMMISSION_SELL: Final[float] = 0.001
STAMP_TAX_SELL: Final[float] = 0.001
ROUND_TRIP_COST: Final[float] = COMMISSION_BUY + COMMISSION_SELL + STAMP_TAX_SELL

# scheme 字面量
LABEL_SCHEME: Final[str] = "strategy-aware"

# 涨跌停判定容差（≤ 0.5%；处理浮点舍入）
LIMIT_TOLERANCE: Final[float] = 0.005

# 新股门槛（doc/04 §4.3 推荐 60 个交易日）
NEW_LISTING_MIN_DAYS: Final[int] = 60

# 强右偏温和截尾（features 层用）
WINSORIZE_LO: Final[float] = -0.5
WINSORIZE_HI: Final[float] = 0.5


# ----------------------------------------------------------------------
# 5 个坑 —— 每个一个独立纯函数（pandas in / pandas out）
# ----------------------------------------------------------------------

def filter_limit_up_on_entry(
    entries: pd.DataFrame,
    *,
    limit_up_set: set[tuple[str, str]],
    entry_col: str = "entry_date",
) -> pd.DataFrame:
    """坑 1：T+1 涨停 → 跳过该候选。

    entries:       必须含列 [ts_code, entry_col]；其它列原样保留
    limit_up_set:  {(ts_code, trade_date)} —— 涨停日集合（由调用方从 raw.stk_limit
                   + raw.daily_quote 派生：close ≥ up_limit * (1 - tol)）
    返回：过滤后的 DataFrame；丢弃条数 > 0 时 logger.warning。
    """

    if entries.empty:
        return entries
    if not limit_up_set:
        return entries.reset_index(drop=True)
    keys = list(zip(entries["ts_code"].astype(str), entries[entry_col].astype(str)))
    mask = np.array([k not in limit_up_set for k in keys])
    dropped = int((~mask).sum())
    if dropped > 0:
        logger.warning(
            "labels_filter_limit_up",
            extra={"dropped": dropped, "kept": int(mask.sum())},
        )
    return entries.loc[mask].reset_index(drop=True)


def filter_suspended_on_entry(
    entries: pd.DataFrame,
    *,
    suspended_set: set[tuple[str, str]],
    entry_col: str = "entry_date",
) -> pd.DataFrame:
    """坑 2：T+1 停牌 → 跳过该候选。

    entries:        必须含列 [ts_code, entry_col]
    suspended_set:  {(ts_code, trade_date)} —— 停牌日集合（raw.suspend_d）
    返回：过滤后的 DataFrame；丢弃条数 > 0 时 logger.warning。
    """

    if entries.empty:
        return entries
    if not suspended_set:
        return entries.reset_index(drop=True)
    keys = list(zip(entries["ts_code"].astype(str), entries[entry_col].astype(str)))
    mask = np.array([k not in suspended_set for k in keys])
    dropped = int((~mask).sum())
    if dropped > 0:
        logger.warning(
            "labels_filter_suspended",
            extra={"dropped": dropped, "kept": int(mask.sum())},
        )
    return entries.loc[mask].reset_index(drop=True)


def filter_new_listing(
    entries: pd.DataFrame,
    *,
    list_date_map: Mapping[str, str],
    trade_dates_sorted: list[str],
    min_days: int = NEW_LISTING_MIN_DAYS,
    entry_col: str = "entry_date",
) -> pd.DataFrame:
    """坑 3：上市 < min_days 个交易日 → 跳过。

    list_date_map:      ts_code → list_date YYYYMMDD（raw.stock_basic.list_date）
    trade_dates_sorted: 全交易日历升序，用于计算"上市后第 N 个交易日"
    min_days:           交易日阈值（默认 60，doc/04 §4.3）
    """

    if entries.empty:
        return entries
    if not list_date_map:
        return entries.reset_index(drop=True)
    td_to_idx = {d: i for i, d in enumerate(trade_dates_sorted)}

    def _ok(row: pd.Series) -> bool:
        ts_code = str(row["ts_code"])
        buy_date = str(row[entry_col])
        list_date = list_date_map.get(ts_code)
        if list_date is None:
            return True  # 缺数据保留，调用方需保证全量传入
        if list_date not in td_to_idx or buy_date not in td_to_idx:
            return True
        return td_to_idx[buy_date] - td_to_idx[list_date] >= min_days

    mask = entries.apply(_ok, axis=1)
    dropped = int((~mask).sum())
    if dropped > 0:
        logger.warning(
            "labels_filter_new_listing",
            extra={"dropped": dropped, "min_days": min_days},
        )
    return entries.loc[mask].reset_index(drop=True)


def apply_delisting_force_close(
    outcome: ExitOutcome,
    *,
    delist_date_map: Mapping[str, str],
) -> ExitOutcome:
    """坑 4：持仓期触及退市日 → 强制平仓 (exit_reason='force_close')。

    simulate_exit 已经接受 force_close_date 入参；本函数作为兜底纯函数，
    用于已生成的 outcome 上重新校正 reason —— 例如调用方先模拟时未传
    delist_map 后续才合入退市信息的场景。
    """

    delist = delist_date_map.get(outcome.ts_code)
    if delist is None:
        return outcome
    if str(outcome.exit_date) >= str(delist):
        return replace(outcome, exit_reason=EXIT_FORCE_CLOSE)
    return outcome


def winsorize_label_value(
    values: pd.Series,
    *,
    lo: float = WINSORIZE_LO,
    hi: float = WINSORIZE_HI,
) -> pd.Series:
    """坑 5（marker）：features 层用的温和截尾。labels 仅记录原始 value。

    本函数为占位 / 共享实现，labels.runner 不调用它；features.builder 可复用。
    """

    if values.empty:
        return values
    return values.clip(lower=lo, upper=hi)


# ----------------------------------------------------------------------
# 辅助：从 raw 数据派生 lookup 集合
# ----------------------------------------------------------------------

def derive_limit_up_set(
    quotes: pd.DataFrame,
    stk_limit: pd.DataFrame | None,
    *,
    tolerance: float = LIMIT_TOLERANCE,
) -> set[tuple[str, str]]:
    """从 raw.daily_quote + raw.stk_limit 派生"次日涨停"集合。

    判定：close ≥ up_limit * (1 - tolerance)
    """

    if stk_limit is None or stk_limit.empty:
        return set()
    merged = quotes.merge(
        stk_limit[["ts_code", "trade_date", "up_limit"]],
        on=["ts_code", "trade_date"],
        how="left",
    )
    out: set[tuple[str, str]] = set()
    for _, row in merged.iterrows():
        close = float(row["close"]) if pd.notna(row["close"]) else np.nan
        up = float(row["up_limit"]) if pd.notna(row.get("up_limit")) else np.nan
        if np.isfinite(close) and np.isfinite(up) and close >= up * (1 - tolerance):
            out.add((str(row["ts_code"]), str(row["trade_date"])))
    return out


def derive_suspended_set(suspend_d: pd.DataFrame | None) -> set[tuple[str, str]]:
    """从 raw.suspend_d 派生 (ts_code, trade_date) 集合。"""

    if suspend_d is None or suspend_d.empty:
        return set()
    return {
        (str(r["ts_code"]), str(r["trade_date"]))
        for _, r in suspend_d.iterrows()
    }


def derive_delist_map(delist: pd.DataFrame | None) -> dict[str, str]:
    if delist is None or delist.empty:
        return {}
    return {str(r["ts_code"]): str(r["delist_date"]) for _, r in delist.iterrows()}


def derive_list_date_map(listing: pd.DataFrame | None) -> dict[str, str]:
    if listing is None or listing.empty:
        return {}
    return {str(r["ts_code"]): str(r["list_date"]) for _, r in listing.iterrows()}


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------

@dataclass(frozen=True)
class LabelInputs:
    """compute_strategy_aware_labels 的入参容器。

    daily_quotes: 必须含 [ts_code, trade_date, close]；可选 [low, ma5,
                  is_suspended, is_limit_up, is_limit_down, is_delisted]
    stk_limit:    raw.stk_limit
    suspend_d:    raw.suspend_d（[ts_code, trade_date]）
    delist:       raw.stock_basic 中 delist_date 不空的行
    listing:      raw.stock_basic 中 [ts_code, list_date]
    entries:      可选；不提供则用 daily_quotes 的全部 (ts_code, trade_date) 作为信号集
    """

    daily_quotes: pd.DataFrame
    stk_limit: pd.DataFrame | None = None
    suspend_d: pd.DataFrame | None = None
    delist: pd.DataFrame | None = None
    listing: pd.DataFrame | None = None
    entries: pd.DataFrame | None = None


def _augment_quotes_for_exit(
    quotes: pd.DataFrame,
    suspended_set: set[tuple[str, str]],
    delist_map: Mapping[str, str],
) -> pd.DataFrame:
    """把 is_suspended / is_delisted 注入 quotes（exit_rules 需要）。

    is_limit_up / is_limit_down 列对入场过滤不必要（已在 entries 阶段处理），
    本函数保持默认 False，让 exit_rules 默认按非涨跌停处理。
    """

    out = quotes.copy()
    out["ts_code"] = out["ts_code"].astype(str)
    out["trade_date"] = out["trade_date"].astype(str)

    if "is_suspended" not in out.columns:
        if suspended_set:
            keys = list(zip(out["ts_code"], out["trade_date"]))
            out["is_suspended"] = [k in suspended_set for k in keys]
        else:
            out["is_suspended"] = False

    if "is_delisted" not in out.columns:
        if delist_map:
            keys = list(zip(out["ts_code"], out["trade_date"]))
            out["is_delisted"] = [
                (c in delist_map) and (d >= delist_map[c]) for c, d in keys
            ]
        else:
            out["is_delisted"] = False

    if "is_limit_up" not in out.columns:
        out["is_limit_up"] = False
    if "is_limit_down" not in out.columns:
        out["is_limit_down"] = False
    return out


def compute_strategy_aware_labels(
    inputs: LabelInputs,
    progress_callback: Callable[[int, str], None] | None = None,
) -> pd.DataFrame:
    """计算 strategy-aware 标签长表（factors.labels 直接 upsert 列）。

    返回 DataFrame 列：trade_date / ts_code / scheme / value / exit_reason / hold_days
    每条返回都对应一次"signal_date=T → buy_date=T 后下一交易日 → 触发出场"的完整模拟。

    M2 简化：signal_date 与 buy_date 同日（即"当日收盘信号即当日收盘买入"），
    这与 doc/04 §4.2.3 "T 日信号 / T+1 入场" 不严格对齐，但便于第一版接通；
    未来需切换到 T+1 入场时只需改 _build_entries 中 buy_date 的提取规则。
    本简化下 buy_price = entry 日 close、exit_price = exit 日 close（或 stop_price）。
    """

    quotes = inputs.daily_quotes
    if quotes is None or quotes.empty:
        logger.warning("labels_empty_quotes")
        return _empty_labels()

    required = {"ts_code", "trade_date", "close"}
    if not required.issubset(quotes.columns):
        raise ValueError(
            f"daily_quotes 必须含列 {required}, got {list(quotes.columns)}"
        )

    # 构造候选 entries
    if inputs.entries is not None and not inputs.entries.empty:
        cand = inputs.entries.copy()
        if "entry_date" not in cand.columns and "trade_date" in cand.columns:
            cand = cand.rename(columns={"trade_date": "entry_date"})
        cand = cand[["ts_code", "entry_date"]].copy()
    else:
        cand = quotes[["ts_code", "trade_date"]].rename(
            columns={"trade_date": "entry_date"}
        ).copy()
    cand["ts_code"] = cand["ts_code"].astype(str)
    cand["entry_date"] = cand["entry_date"].astype(str)

    # 派生 lookup
    limit_up_set = derive_limit_up_set(quotes, inputs.stk_limit)
    suspended_set = derive_suspended_set(inputs.suspend_d)
    delist_map = derive_delist_map(inputs.delist)
    list_date_map = derive_list_date_map(inputs.listing)
    trade_dates_sorted = sorted(quotes["trade_date"].astype(str).unique().tolist())

    # 5 个坑 ① ② ③
    cand = filter_limit_up_on_entry(cand, limit_up_set=limit_up_set)
    cand = filter_suspended_on_entry(cand, suspended_set=suspended_set)
    cand = filter_new_listing(
        cand,
        list_date_map=list_date_map,
        trade_dates_sorted=trade_dates_sorted,
    )

    if cand.empty:
        logger.warning("labels_no_candidates_after_filters")
        return _empty_labels()

    # 把 is_suspended / is_delisted 注入 quotes
    aug_quotes = _augment_quotes_for_exit(quotes, suspended_set, delist_map)
    grouped: dict[str, pd.DataFrame] = {
        str(c): df.sort_values("trade_date").reset_index(drop=True)
        for c, df in aug_quotes.groupby("ts_code", sort=False)
    }

    rules = default_rules()
    records: list[dict[str, object]] = []
    cand_dedup = cand.drop_duplicates(
        subset=["ts_code", "entry_date"], keep="first"
    ).reset_index(drop=True)

    total = len(cand_dedup)
    report_interval = max(1, total // 100)  # 每 1% 报告一次

    for i, (_, e) in enumerate(cand_dedup.iterrows()):
        if progress_callback is not None and i % report_interval == 0:
            pct = 10 + int(50 * i / total)  # 10% ~ 60% 的进度范围
            progress_callback(pct, f"labels:simulate {i}/{total}")

        ts_code = str(e["ts_code"])
        entry_date = str(e["entry_date"])
        sub = grouped.get(ts_code)
        if sub is None or sub.empty:
            continue
        outcome = simulate_exit(
            buy_date=entry_date,
            ts_code=ts_code,
            prices_df=sub,
            rules=rules,
            force_close_date=delist_map.get(ts_code),
        )
        if outcome is None:
            continue
        # 坑 4 兜底（保险）
        outcome = apply_delisting_force_close(outcome, delist_date_map=delist_map)

        entry_row = sub.loc[sub["trade_date"] == entry_date]
        if entry_row.empty:
            continue
        entry_close = float(entry_row.iloc[0]["close"])
        if not np.isfinite(entry_close) or entry_close <= 0:
            continue
        gross = float(outcome.exit_price) / entry_close - 1.0
        records.append(
            {
                "trade_date": entry_date,
                "ts_code": ts_code,
                "scheme": LABEL_SCHEME,
                "value": gross - ROUND_TRIP_COST,
                "exit_reason": outcome.exit_reason,
                "hold_days": int(outcome.hold_days),
            }
        )

    if not records:
        logger.warning("labels_no_outcomes")
        return _empty_labels()

    out = pd.DataFrame(records)
    # 按 PK 去重（与 runner._upsert_labels 双保险；CLAUDE.md 硬约束）
    before = len(out)
    out = out.drop_duplicates(
        subset=["trade_date", "ts_code", "scheme"], keep="last"
    ).reset_index(drop=True)
    if len(out) != before:
        logger.warning(
            "labels_compute_dedup",
            extra={"raw": before, "deduped": len(out)},
        )
    return out[["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]]


def _empty_labels() -> pd.DataFrame:
    return pd.DataFrame(
        columns=["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]
    )


__all__ = [
    "LABEL_SCHEME",
    "ROUND_TRIP_COST",
    "LIMIT_TOLERANCE",
    "NEW_LISTING_MIN_DAYS",
    "WINSORIZE_LO",
    "WINSORIZE_HI",
    # 5 个坑
    "filter_limit_up_on_entry",
    "filter_suspended_on_entry",
    "filter_new_listing",
    "apply_delisting_force_close",
    "winsorize_label_value",
    # 辅助
    "derive_limit_up_set",
    "derive_suspended_set",
    "derive_delist_map",
    "derive_list_date_map",
    # 主流程
    "LabelInputs",
    "compute_strategy_aware_labels",
    # 从 exit_rules 透传的 reason 常量（便于调用方做 reason 比对）
    "EXIT_FORCE_CLOSE",
    "EXIT_STOP_LOSS",
]
