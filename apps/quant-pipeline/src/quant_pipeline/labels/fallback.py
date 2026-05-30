# -*- coding: utf-8 -*-
"""Fwd_5d_ret 兜底标签（doc/量化/04 §4.1）。

简单 5 日后向收益率（毛收益，未扣交易成本）：
    value = close_adj[t+5] / close_adj[t] - 1

口径声明（见 spec 02 §item-4，项目决策）：
  - value 为**毛收益**（未扣交易成本）。`fwd_5d_ret` 是 **T 日起算**的简单前向
    收益，无 T+1 入场概念 —— 学术 baseline / 单因子 IC 研究惯例用毛收益。
  - strategy-aware 的 value 同为毛收益（T+1 入场）；两 scheme value 口径统一为
    毛收益、彼此可比，交易成本由 portfolio 评估层统一扣减。差异仅在入场时点
    与出场规则。两 scheme 写同一张 factors.labels。

适用场景（doc/04 §4.2.8）：
  - 因子研究阶段（单因子 IC）
  - 多策略并行的母模型
  - 论文 / 学术对标 baseline

实现要点：
  - 后复权 close（runner 用 raw.adj_factor 反推，注入 close_adj 列）
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

import pandas as pd

from quant_pipeline.labels._common import dedup_labels, empty_labels_frame
from quant_pipeline.labels.strategy_aware import (
    NEW_LISTING_MIN_DAYS,
    _validate_min_days,
    filter_new_listing,
)

logger = logging.getLogger(__name__)

SCHEME_FWD_5D_RET: Final[str] = "fwd_5d_ret"
FWD_HORIZON_DAYS: Final[int] = 5


@dataclass(frozen=True)
class FallbackInputs:
    """daily_quotes 必须含 [ts_code, trade_date, close_adj]（后复权 close）。

    close_adj 由 labels.runner 经 _common.apply_hfq 注入（见 spec 01）。
    suspended_set: {(ts_code, trade_date)} 停牌日集合
    delist_map:    ts_code → delist_date
    """

    daily_quotes: pd.DataFrame
    suspended_set: set[tuple[str, str]] | None = None
    delist_map: Mapping[str, str] | None = None
    # 新股过滤（D-1 缺口补齐）：listing 为 None 时跳过过滤（向后兼容老调用方）；
    # new_listing_min_days 为 None 时走默认 NEW_LISTING_MIN_DAYS(60)，0 表示不过滤。
    listing: pd.DataFrame | None = None
    new_listing_min_days: int | None = None


def compute_fwd_5d_ret(
    inputs: FallbackInputs,
    *,
    fwd_horizon_days: int | None = None,
) -> pd.DataFrame:
    """计算 fwd_5d_ret 兜底标签长表，列同 factors.labels。

    向量化实现：groupby + shift(-horizon) 一次成型，组内 shift 不跨票。

    Args:
        fwd_horizon_days: 前向收益视界（交易日）。None → 走模块默认
            ``FWD_HORIZON_DAYS``(5)，保证不传时行为完全不变（spec 02 §标签参数透传）。
            视界写入 ``hold_days`` 列，并决定每票末尾被 shift 丢弃的行数。
    """

    horizon = FWD_HORIZON_DAYS if fwd_horizon_days is None else int(fwd_horizon_days)
    if horizon < 1:
        raise ValueError(f"fwd_horizon_days 必须 >= 1，got {fwd_horizon_days!r}")

    quotes = inputs.daily_quotes
    if quotes is None or quotes.empty:
        # runner 已在调用前对空 quotes raise；此分支仅作直接调用兜底。
        logger.warning("fallback_labels_empty_quotes")
        return empty_labels_frame()

    required = {"ts_code", "trade_date", "close_adj"}
    if not required.issubset(quotes.columns):
        raise ValueError(
            f"daily_quotes 必须含列 {required}, got {list(quotes.columns)}"
        )

    quotes = quotes.copy()
    quotes["ts_code"] = quotes["ts_code"].astype(str)
    quotes["trade_date"] = quotes["trade_date"].astype(str)
    quotes["close_adj"] = pd.to_numeric(quotes["close_adj"], errors="coerce")

    suspended_set: set[tuple[str, str]] = inputs.suspended_set or set()
    delist_map: Mapping[str, str] = inputs.delist_map or {}

    quotes = quotes.sort_values(["ts_code", "trade_date"]).reset_index(drop=True)
    g = quotes.groupby("ts_code", sort=False)
    # 组内 shift：c_t5 / t_plus_date 取该票未来第 horizon 日，不跨票
    c_t = quotes["close_adj"]
    c_t5 = g["close_adj"].shift(-horizon)
    t_plus_date = g["trade_date"].shift(-horizon)

    value = c_t5 / c_t - 1.0

    keep = (
        t_plus_date.notna()          # 每票末 horizon 行 shift 丢弃
        & c_t.notna() & (c_t > 0)
        & c_t5.notna()
    )

    ts = quotes["ts_code"]
    t = quotes["trade_date"]
    # 停牌掩码：t 或 t+5 任一停牌 → 跳过
    if suspended_set:
        susp_t = pd.Series(list(zip(ts, t)), index=quotes.index).isin(suspended_set)
        susp_t5 = pd.Series(
            list(zip(ts, t_plus_date.fillna(""))), index=quotes.index
        ).isin(suspended_set)
        keep = keep & ~susp_t & ~susp_t5
    # 退市掩码：t+5 >= delist_date → 跳过
    if delist_map:
        delist_for_ts = ts.map(delist_map)
        crossed = delist_for_ts.notna() & (
            t_plus_date.fillna("") >= delist_for_ts.fillna("")
        )
        keep = keep & ~crossed

    keep = keep.to_numpy(dtype=bool)
    if not keep.any():
        logger.warning("fallback_labels_no_outcomes")
        return empty_labels_frame()

    out = pd.DataFrame(
        {
            "trade_date": t[keep].astype(str).to_numpy(),
            "ts_code": ts[keep].astype(str).to_numpy(),
            "scheme": SCHEME_FWD_5D_RET,
            "value": value[keep].astype(float).to_numpy(),
            "exit_reason": "fwd_horizon",
            "hold_days": horizon,
        }
    )

    # 新股过滤（D-1 缺口补齐）：仅当显式传入 listing 时启用，向后兼容老调用方。
    # 锚列用 trade_date（SubAgent 实测；fwd_5d_ret 无 T+1 入场概念，T 日即起算日）。
    if inputs.listing is not None:
        min_days = (
            inputs.new_listing_min_days
            if inputs.new_listing_min_days is not None
            else NEW_LISTING_MIN_DAYS
        )
        _validate_min_days(min_days)
        # min_days=0 显式短路，避免白跑一遍 filter_new_listing
        if min_days > 0:
            listing_df = inputs.listing
            if not listing_df.empty:
                list_date_map = dict(
                    zip(
                        listing_df["ts_code"].astype(str),
                        listing_df["list_date"].astype(str),
                    )
                )
                # 用 quotes 自身派生交易日历（已用 end_padded，覆盖出参 trade_date 全集）
                trade_dates_sorted = sorted(
                    quotes["trade_date"].astype(str).unique().tolist()
                )
                out = filter_new_listing(
                    out,
                    list_date_map=list_date_map,
                    trade_dates_sorted=trade_dates_sorted,
                    min_days=min_days,
                    entry_col="trade_date",
                )
                if out.empty:
                    logger.warning("fallback_labels_all_filtered_new_listing")
                    return empty_labels_frame()
    out = dedup_labels(out, log_key="fallback_labels_dedup")
    return out[["trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"]]


__all__ = [
    "SCHEME_FWD_5D_RET",
    "FWD_HORIZON_DAYS",
    "FallbackInputs",
    "compute_fwd_5d_ret",
]
