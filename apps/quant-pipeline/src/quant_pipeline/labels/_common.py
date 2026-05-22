# -*- coding: utf-8 -*-
"""labels 子系统共用助手。

收拢原先散落在 fallback.py / strategy_aware.py 的重复实现：
  - apply_hfq             后复权：注入 close_adj / low_adj
  - empty_labels_frame    空标签 DataFrame（列与 factors.labels 一致）
  - dedup_labels          按 PK 去重 + 条数变化时 warning
  - derive_limit_up_set / derive_suspended_set / derive_delist_map /
    derive_list_date_map  从 raw 数据派生 lookup（向量化版）
  - PROGRESS_* 进度常量

约定（见 spec 01-common-and-adjustment.md §1）：
  - ROUND_TRIP_COST 不迁入（仅 strategy_aware 用，留在原处）。
  - dedup_labels 按 ["trade_date","ts_code","scheme"] 去重 keep="last"。
"""

from __future__ import annotations

import logging

import pandas as pd

logger = logging.getLogger(__name__)

# ----------------------------------------------------------------------
# 进度常量（不变式见下）
# ----------------------------------------------------------------------
PROGRESS_LOAD: int = 10
PROGRESS_SIMULATE_START: int = 10   # 不变式：PROGRESS_SIMULATE_START == PROGRESS_LOAD
PROGRESS_SIMULATE_SPAN: int = 50
PROGRESS_COMPUTE_DONE: int = 60     # 不变式：== PROGRESS_SIMULATE_START + PROGRESS_SIMULATE_SPAN
PROGRESS_DONE: int = 100

# 标签长表列（与 factors.labels 一致）
_LABEL_COLUMNS: list[str] = [
    "trade_date", "ts_code", "scheme", "value", "exit_reason", "hold_days"
]


# ----------------------------------------------------------------------
# 后复权
# ----------------------------------------------------------------------

def apply_hfq(df: pd.DataFrame) -> pd.DataFrame:
    """注入后复权列 close_adj / low_adj。

    后复权基准 = 窗口内该 ts_code 的 max(adj_factor)，与 factors/runner.py 一致。
    adj_factor 为 NULL 的行 → close_adj/low_adj 为 NaN；统计并 warn。

    收益率对复权基准不敏感（基准在 exit/entry 比值中约掉），但全 pipeline 统一用
    「窗口 max」基准，与 factors 模块口径一致。
    """

    out = df.copy()
    af = pd.to_numeric(out["adj_factor"], errors="coerce")
    max_af = af.groupby(out["ts_code"]).transform("max")
    out["close_adj"] = out["close"] * af / max_af
    if "low" in out.columns:
        out["low_adj"] = out["low"] * af / max_af
    na_cnt = int(af.isna().sum())
    if na_cnt > 0:
        logger.warning(
            "apply_hfq_adj_factor_missing",
            extra={"na_rows": na_cnt, "total": len(out)},
        )
    return out


# ----------------------------------------------------------------------
# 标签 DataFrame 助手
# ----------------------------------------------------------------------

def empty_labels_frame() -> pd.DataFrame:
    """返回空的标签长表（列与 factors.labels 一致）。"""

    return pd.DataFrame(columns=list(_LABEL_COLUMNS))


def dedup_labels(df: pd.DataFrame, *, log_key: str) -> pd.DataFrame:
    """按 PK (trade_date, ts_code, scheme) 去重 keep="last"。

    条数变化时 logger.warning(log_key, extra={"raw":.., "deduped":..})。
    """

    before = len(df)
    out = df.drop_duplicates(
        subset=["trade_date", "ts_code", "scheme"], keep="last"
    ).reset_index(drop=True)
    if len(out) != before:
        logger.warning(log_key, extra={"raw": before, "deduped": len(out)})
    return out


# ----------------------------------------------------------------------
# 从 raw 数据派生 lookup 集合（向量化）
# ----------------------------------------------------------------------

def derive_limit_up_set(
    quotes: pd.DataFrame,
    stk_limit: pd.DataFrame | None,
    *,
    tolerance: float = 0.005,
) -> set[tuple[str, str]]:
    """从 raw.daily_quote + raw.stk_limit 派生「涨停」集合。

    判定：close ≥ up_limit * (1 - tolerance)。用 **raw close**（未复权），
    与 raw up_limit 口径一致（见 spec 01 §2.5）。
    """

    if stk_limit is None or stk_limit.empty:
        return set()
    merged = quotes.merge(
        stk_limit[["ts_code", "trade_date", "up_limit"]],
        on=["ts_code", "trade_date"],
        how="left",
    )
    close = pd.to_numeric(merged["close"], errors="coerce")
    up = pd.to_numeric(merged["up_limit"], errors="coerce")
    hit = close.notna() & up.notna() & (close >= up * (1 - tolerance))
    return set(
        zip(
            merged.loc[hit, "ts_code"].astype(str),
            merged.loc[hit, "trade_date"].astype(str),
        )
    )


def derive_suspended_set(suspend_d: pd.DataFrame | None) -> set[tuple[str, str]]:
    """从 raw.suspend_d 派生 (ts_code, trade_date) 集合。"""

    if suspend_d is None or suspend_d.empty:
        return set()
    return set(
        zip(
            suspend_d["ts_code"].astype(str),
            suspend_d["trade_date"].astype(str),
        )
    )


def derive_delist_map(delist: pd.DataFrame | None) -> dict[str, str]:
    """从退市信息派生 ts_code → delist_date。"""

    if delist is None or delist.empty:
        return {}
    return dict(
        zip(
            delist["ts_code"].astype(str),
            delist["delist_date"].astype(str),
        )
    )


def derive_list_date_map(listing: pd.DataFrame | None) -> dict[str, str]:
    """从上市信息派生 ts_code → list_date。"""

    if listing is None or listing.empty:
        return {}
    return dict(
        zip(
            listing["ts_code"].astype(str),
            listing["list_date"].astype(str),
        )
    )


__all__ = [
    "PROGRESS_LOAD",
    "PROGRESS_SIMULATE_START",
    "PROGRESS_SIMULATE_SPAN",
    "PROGRESS_COMPUTE_DONE",
    "PROGRESS_DONE",
    "apply_hfq",
    "empty_labels_frame",
    "dedup_labels",
    "derive_limit_up_set",
    "derive_suspended_set",
    "derive_delist_map",
    "derive_list_date_map",
]
