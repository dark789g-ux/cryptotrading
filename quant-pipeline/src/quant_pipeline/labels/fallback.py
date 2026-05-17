# -*- coding: utf-8 -*-
"""Fwd_5d_ret 兜底标签（doc/量化/04 §4.1）。

简单 5 日后向收益率：
    value = close_adj[t+5] / close_adj[t] - 1

适用场景（doc/04 §4.2.8）：
  - 因子研究阶段（单因子 IC）
  - 多策略并行的母模型
  - 论文 / 学术对标 baseline

实现要点：
  - 后复权 close（runner 用 raw.adj_factor 反推）
  - 停牌：t 或 t+5 日停牌 → 跳过该样本
  - 退市：跨越退市日的样本 → 跳过
  - 标签 trade_date 字段写 t（信号日）

scheme = 'fwd_5d_ret'
"""

from __future__ import annotations

import logging
from collections.abc import Mapping
from dataclasses import dataclass
from typing import Final

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)

SCHEME_FWD_5D_RET: Final[str] = "fwd_5d_ret"
FWD_HORIZON_DAYS: Final[int] = 5


@dataclass(frozen=True)
class FallbackInputs:
    """daily_quotes 必须含 [ts_code, trade_date, close]（建议 close_adj 后复权）。

    suspended_set: {(ts_code, trade_date)} 停牌日集合
    delist_map:    ts_code → delist_date
    """

    daily_quotes: pd.DataFrame
    suspended_set: set[tuple[str, str]] | None = None
    delist_map: Mapping[str, str] | None = None


def compute_fwd_5d_ret(inputs: FallbackInputs) -> pd.DataFrame:
    """计算 fwd_5d_ret 兜底标签长表，列同 factors.labels。"""

    quotes = inputs.daily_quotes
    if quotes is None or quotes.empty:
        logger.warning("fallback_labels_empty_quotes")
        return _empty()

    required = {"ts_code", "trade_date", "close"}
    if not required.issubset(quotes.columns):
        raise ValueError(
            f"daily_quotes 必须含列 {required}, got {list(quotes.columns)}"
        )

    quotes = quotes.copy()
    quotes["ts_code"] = quotes["ts_code"].astype(str)
    quotes["trade_date"] = quotes["trade_date"].astype(str)
    quotes["close"] = pd.to_numeric(quotes["close"], errors="coerce")

    suspended_set: set[tuple[str, str]] = inputs.suspended_set or set()
    delist_map: Mapping[str, str] = inputs.delist_map or {}

    records: list[dict[str, object]] = []
    for ts_code, sub in quotes.groupby("ts_code", sort=False):
        sub = sub.sort_values("trade_date").reset_index(drop=True)
        for i in range(len(sub) - FWD_HORIZON_DAYS):
            t_row = sub.iloc[i]
            t = str(t_row["trade_date"])
            t_plus = sub.iloc[i + FWD_HORIZON_DAYS]
            t_plus_date = str(t_plus["trade_date"])
            ts = str(ts_code)
            # 停牌跳过
            if (ts, t) in suspended_set or (ts, t_plus_date) in suspended_set:
                continue
            # 退市跨越跳过
            delist = delist_map.get(ts)
            if delist is not None and t_plus_date >= delist:
                continue
            c_t = float(t_row["close"])
            c_t5 = float(t_plus["close"])
            if not np.isfinite(c_t) or c_t <= 0:
                continue
            if not np.isfinite(c_t5):
                continue
            value = c_t5 / c_t - 1.0
            records.append(
                {
                    "trade_date": t,
                    "ts_code": ts,
                    "scheme": SCHEME_FWD_5D_RET,
                    "value": float(value),
                    "exit_reason": "fwd_horizon",
                    "hold_days": FWD_HORIZON_DAYS,
                }
            )

    if not records:
        logger.warning("fallback_labels_no_outcomes")
        return _empty()
    out = pd.DataFrame(records)
    before = len(out)
    out = out.drop_duplicates(
        subset=["trade_date", "ts_code", "scheme"], keep="last"
    ).reset_index(drop=True)
    if len(out) != before:
        logger.warning(
            "fallback_labels_dedup",
            extra={"raw": before, "deduped": len(out)},
        )
    return out[["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]]


def _empty() -> pd.DataFrame:
    return pd.DataFrame(
        columns=["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]
    )


__all__ = [
    "SCHEME_FWD_5D_RET",
    "FWD_HORIZON_DAYS",
    "FallbackInputs",
    "compute_fwd_5d_ret",
]
