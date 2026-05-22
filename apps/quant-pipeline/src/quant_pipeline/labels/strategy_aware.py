# -*- coding: utf-8 -*-
"""Strategy-aware labels（doc/量化/04 §4.2 推荐主用方案）。

调用 strategy.exit_rules.simulate_exit 对每个 (signal_date, ts_code) 模拟
"次日开盘买入 → 触发出场规则" 产生标签：
  value       = (exit_price - buy_price) / buy_price（毛收益，未扣成本）
  exit_reason = ma5_break / stop_loss / max_hold / force_close
  hold_days   = 实际持仓交易日数

入场日规范（doc/04 §4.2.3）—— 真 T+1 入场：
  signal_date = T；buy_date = T+1（窗口交易日历中 T 的下一交易日）。
  buy_price = T+1 日 close_adj（后复权；M2 简化，未来回测可换 VWAP）。
  收益率统一用后复权价 close_adj（见 spec 01）。

口径声明（见 spec 02 §item-4，项目决策）：
  strategy-aware 的 value 为**毛收益**（不扣交易成本）；交易成本由 portfolio
  评估层统一扣减。两 scheme（strategy-aware / fwd_5d_ret）value 口径统一为毛收益，
  彼此可比。strategy-aware 与 fwd_5d_ret 的差异仅在入场时点（T+1 vs T 日起算）
  与出场规则。ROUND_TRIP_COST 常量保留并导出，供 portfolio 评估层引用。

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
  4. 退市 force_close              退市：force_close 完全由 simulate_exit 的
                                   force_close_date 入参处理，无独立函数
  5. winsorize_label_value         强右偏温和截尾在 features 层做，labels 不实现
                                   截尾；本函数为共享实现，由 features.builder 复用

CLAUDE.md 硬约束：
  - upsert 前 PK 去重（runner 负责）
  - fetcher 空数据 warn（本模块的 entries 空走 logger.warning + 直接 return）
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Callable, Final

import numpy as np
import pandas as pd

from quant_pipeline.labels._common import (
    PROGRESS_SIMULATE_SPAN,
    PROGRESS_SIMULATE_START,
    dedup_labels,
    derive_delist_map,
    derive_limit_up_set,
    derive_list_date_map,
    derive_suspended_set,
    empty_labels_frame,
)
from quant_pipeline.strategy.exit_rules import (
    EXIT_FORCE_CLOSE,
    EXIT_STOP_LOSS,
    MAX_HOLD_DAYS,
    default_rules,
    simulate_exit,
)

logger = logging.getLogger(__name__)

# 双边成本（doc/量化/04 §4.2 推荐）。
# labels.value 不再扣此成本（项目决策：label 输出毛收益）；保留并导出供
# portfolio 评估层在组合收益上统一扣减。
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

# 强右偏温和截尾阈值（坑 5）。labels 不实现截尾，截尾在 features 层做；
# 这两个常量与 winsorize_label_value 由 features.builder 复用（见函数 docstring）。
WINSORIZE_LO: Final[float] = -0.5
WINSORIZE_HI: Final[float] = 0.5


# ----------------------------------------------------------------------
# 5 个坑 —— 每个一个独立纯函数（pandas in / pandas out）
# ----------------------------------------------------------------------

def filter_limit_up_on_entry(
    entries: pd.DataFrame,
    *,
    limit_up_set: set[tuple[str, str]],
    entry_col: str = "buy_date",
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
    entry_col: str = "buy_date",
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
    entry_col: str = "buy_date",
) -> pd.DataFrame:
    """坑 3：上市 < min_days 个交易日 → 跳过（向量化）。

    list_date_map:      ts_code → list_date YYYYMMDD（raw.stock_basic.list_date）
    trade_dates_sorted: 全交易日历升序，用于计算"上市后第 N 个交易日"
    min_days:           交易日阈值（默认 60，doc/04 §4.3）

    语义：list_date 缺失、或 list_date / buy_date 不在交易日历 → 保留。
    """

    if entries.empty:
        return entries
    if not list_date_map:
        return entries.reset_index(drop=True)
    td_to_idx = {d: i for i, d in enumerate(trade_dates_sorted)}

    buy_idx = entries[entry_col].astype(str).map(td_to_idx)
    list_date = entries["ts_code"].astype(str).map(list_date_map)
    list_idx = list_date.map(td_to_idx)
    keep = (
        list_date.isna()
        | list_idx.isna()
        | buy_idx.isna()
        | ((buy_idx - list_idx) >= min_days)
    )
    keep = keep.to_numpy(dtype=bool)
    dropped = int((~keep).sum())
    if dropped > 0:
        logger.warning(
            "labels_filter_new_listing",
            extra={"dropped": dropped, "min_days": min_days},
        )
    return entries.loc[keep].reset_index(drop=True)


def winsorize_label_value(
    values: pd.Series,
    *,
    lo: float = WINSORIZE_LO,
    hi: float = WINSORIZE_HI,
) -> pd.Series:
    """坑 5：强右偏温和截尾。labels.runner 不调用本函数（labels 保留原始 value）。

    本函数为共享实现，实际消费方是 features.builder（features 层做温和截尾）。
    """

    if values.empty:
        return values
    return values.clip(lower=lo, upper=hi)


# ----------------------------------------------------------------------
# 主流程
# ----------------------------------------------------------------------

@dataclass(frozen=True)
class LabelInputs:
    """compute_strategy_aware_labels 的入参容器。

    daily_quotes: 必须含 [ts_code, trade_date, close, close_adj]；可选
                  [low, low_adj, adj_factor, ma5, is_suspended, is_limit_up,
                  is_limit_down, is_delisted]。close_adj/low_adj 为后复权价
                  （见 spec 01）。
    stk_limit:    raw.stk_limit
    suspend_d:    raw.suspend_d（[ts_code, trade_date]）
    delist:       退市信息中 delist_date 不空的行
    listing:      上市信息 [ts_code, list_date]
    entries:      可选；不提供则用 daily_quotes 的全部 (ts_code, trade_date) 作为
                  信号集。entries 的 trade_date 列含义为信号日 T。
    end:          可选；查询区间结束日 YYYYMMDD。用于「数据末尾截断」warning 的
                  判别（exit_date >= end 才视为缓冲尾部截断，见 spec 03 §item-5）。
                  缺省时退化为窗口最后一个交易日。
    """

    daily_quotes: pd.DataFrame
    stk_limit: pd.DataFrame | None = None
    suspend_d: pd.DataFrame | None = None
    delist: pd.DataFrame | None = None
    listing: pd.DataFrame | None = None
    entries: pd.DataFrame | None = None
    end: str | None = None


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


def _prices_for_simulator(sub: pd.DataFrame) -> pd.DataFrame:
    """把 per-stock 切片转成 simulate_exit 需要的价格表。

    close_adj → close、low_adj → low（spec 01 §2.6）：模拟器消费后复权价，
    与 exit_rules 注释「含复权」一致。raw close/low 仅用于涨停派生（已在前置
    阶段完成），此处不再需要。
    """

    out = sub.copy()
    if "close_adj" in out.columns:
        out["close"] = out["close_adj"]
    if "low_adj" in out.columns:
        out["low"] = out["low_adj"]
    return out


def compute_strategy_aware_labels(
    inputs: LabelInputs,
    progress_callback: Callable[[int, str], None] | None = None,
) -> pd.DataFrame:
    """计算 strategy-aware 标签长表（factors.labels 直接 upsert 列）。

    返回 DataFrame 列：trade_date / ts_code / scheme / value / exit_reason / hold_days

    每条返回都对应一次「signal_date=T → buy_date=T+1 → 触发出场」的完整模拟：
      - trade_date 写信号日 T；
      - buy_price = T+1 日 close_adj；
      - exit_price 由 simulate_exit 给出（后复权价）；
      - value = exit_price / buy_price - 1（毛收益，不扣成本；成本由 portfolio 扣）。
    信号日为窗口最后一个交易日、取不到 T+1 → 跳过该候选（边界样本，正常）。
    """

    quotes = inputs.daily_quotes
    if quotes is None or quotes.empty:
        logger.warning("labels_empty_quotes")
        return empty_labels_frame()

    required = {"ts_code", "trade_date", "close", "close_adj"}
    if not required.issubset(quotes.columns):
        raise ValueError(
            f"daily_quotes 必须含列 {required}, got {list(quotes.columns)}"
        )

    # 窗口交易日历（升序去重）。trade_date 为 YYYYMMDD 定宽字符串，字典序即时序。
    trade_dates_sorted = sorted(quotes["trade_date"].astype(str).unique().tolist())
    next_day = {
        d: trade_dates_sorted[i + 1]
        for i, d in enumerate(trade_dates_sorted[:-1])
    }

    # 构造候选 entries（trade_date = 信号日 T）
    if inputs.entries is not None and not inputs.entries.empty:
        cand = inputs.entries.copy()
        cand = cand[["ts_code", "trade_date"]].rename(
            columns={"trade_date": "signal_date"}
        )
    else:
        cand = quotes[["ts_code", "trade_date"]].rename(
            columns={"trade_date": "signal_date"}
        ).copy()
    cand["ts_code"] = cand["ts_code"].astype(str)
    cand["signal_date"] = cand["signal_date"].astype(str)

    # 派生 buy_date = 信号日的下一交易日；取不到 → 丢弃（窗口末日边界样本）
    cand["buy_date"] = cand["signal_date"].map(next_day)
    cand = cand[cand["buy_date"].notna()].reset_index(drop=True)
    if cand.empty:
        logger.warning("labels_no_candidates_after_t1")
        return empty_labels_frame()

    # 派生 lookup
    limit_up_set = derive_limit_up_set(
        quotes, inputs.stk_limit, tolerance=LIMIT_TOLERANCE
    )
    suspended_set = derive_suspended_set(inputs.suspend_d)
    delist_map = derive_delist_map(inputs.delist)
    list_date_map = derive_list_date_map(inputs.listing)

    # 5 个坑 ① ② ③ —— 全部以 buy_date（T+1）为准
    cand = filter_limit_up_on_entry(
        cand, limit_up_set=limit_up_set, entry_col="buy_date"
    )
    cand = filter_suspended_on_entry(
        cand, suspended_set=suspended_set, entry_col="buy_date"
    )
    cand = filter_new_listing(
        cand,
        list_date_map=list_date_map,
        trade_dates_sorted=trade_dates_sorted,
        entry_col="buy_date",
    )

    if cand.empty:
        logger.warning("labels_no_candidates_after_filters")
        return empty_labels_frame()

    # 把 is_suspended / is_delisted 注入 quotes，再转成模拟器消费的后复权价格表
    aug_quotes = _augment_quotes_for_exit(quotes, suspended_set, delist_map)
    grouped: dict[str, pd.DataFrame] = {
        str(c): _prices_for_simulator(
            df.sort_values("trade_date").reset_index(drop=True)
        )
        for c, df in aug_quotes.groupby("ts_code", sort=False)
    }

    # 数据末尾截断 warning 的判别基准：查询区间 end，缺省退化为窗口末日
    truncation_threshold = str(inputs.end) if inputs.end else trade_dates_sorted[-1]

    rules = default_rules()
    records: list[dict[str, object]] = []
    # 按信号日去重（同一票同一信号日只保留一条候选）
    cand_dedup = cand.drop_duplicates(
        subset=["ts_code", "signal_date"], keep="first"
    ).reset_index(drop=True)

    total = len(cand_dedup)
    report_interval = max(1, total // 100)  # 每 1% 报告一次

    for i, (_, e) in enumerate(cand_dedup.iterrows()):
        if progress_callback is not None and i % report_interval == 0:
            pct = PROGRESS_SIMULATE_START + int(PROGRESS_SIMULATE_SPAN * i / total)
            progress_callback(pct, f"labels:simulate {i}/{total}")

        ts_code = str(e["ts_code"])
        signal_date = str(e["signal_date"])
        buy_date = str(e["buy_date"])
        sub = grouped.get(ts_code)
        if sub is None or sub.empty:
            continue
        outcome = simulate_exit(
            buy_date=buy_date,
            ts_code=ts_code,
            prices_df=sub,
            rules=rules,
            force_close_date=delist_map.get(ts_code),
        )
        if outcome is None:
            continue

        buy_row = sub.loc[sub["trade_date"] == buy_date]
        if buy_row.empty:
            continue
        buy_close = float(buy_row.iloc[0]["close"])
        if not np.isfinite(buy_close) or buy_close <= 0:
            continue
        gross = float(outcome.exit_price) / buy_close - 1.0

        # 数据末尾截断暴露（spec 03 §item-5）：force_close 且未达 max_hold、
        # 非真退市、退出日落在缓冲尾部 → warning
        if (
            outcome.exit_reason == EXIT_FORCE_CLOSE
            and outcome.hold_days < MAX_HOLD_DAYS
            and ts_code not in delist_map
            and str(outcome.exit_date) >= truncation_threshold
        ):
            logger.warning(
                "labels_force_close_truncated",
                extra={
                    "ts_code": ts_code,
                    "signal_date": signal_date,
                    "hold_days": int(outcome.hold_days),
                    "exit_date": str(outcome.exit_date),
                },
            )

        records.append(
            {
                "trade_date": signal_date,
                "ts_code": ts_code,
                "scheme": LABEL_SCHEME,
                # 毛收益（项目决策）：不扣 ROUND_TRIP_COST，成本由 portfolio 评估层扣
                "value": gross,
                "exit_reason": outcome.exit_reason,
                "hold_days": int(outcome.hold_days),
            }
        )

    if not records:
        logger.warning("labels_no_outcomes")
        return empty_labels_frame()

    out = pd.DataFrame(records)
    # 按 PK 去重（与 runner._upsert_labels 双保险；CLAUDE.md 硬约束）
    out = dedup_labels(out, log_key="labels_compute_dedup")
    return out[["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]]


__all__ = [
    "LABEL_SCHEME",
    "ROUND_TRIP_COST",
    "LIMIT_TOLERANCE",
    "NEW_LISTING_MIN_DAYS",
    "WINSORIZE_LO",
    "WINSORIZE_HI",
    # 5 个坑（坑 1/2/3/5 有独立纯函数；坑 4 见模块 docstring）
    "filter_limit_up_on_entry",
    "filter_suspended_on_entry",
    "filter_new_listing",
    "winsorize_label_value",
    # 主流程
    "LabelInputs",
    "compute_strategy_aware_labels",
    # 从 exit_rules 透传的 reason 常量（便于调用方做 reason 比对）
    "EXIT_FORCE_CLOSE",
    "EXIT_STOP_LOSS",
]
