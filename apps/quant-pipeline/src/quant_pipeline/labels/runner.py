# -*- coding: utf-8 -*-
"""labels runner：DB IO 层。

职责：
1. 从 raw 表加载 daily_quote / stk_limit / suspend_d / 退市 / 上市 信息
2. 调 strategy_aware.compute_strategy_aware_labels 计算标签
3. upsert 到 factors.labels（PK 去重）
4. 每日进度回写

dispatcher 路由：run_type='labels' → runner_entrypoint。
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID

import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.labels.fallback import (
    FallbackInputs,
    SCHEME_FWD_5D_RET,
    compute_fwd_5d_ret,
)
from quant_pipeline.labels.strategy_aware import (
    LABEL_SCHEME,
    LabelInputs,
    compute_strategy_aware_labels,
    derive_delist_map,
    derive_suspended_set,
)
from quant_pipeline.worker.progress import (
    JobCancelled,
    ProgressCallback,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# 数据加载
# ----------------------------------------------------------------------

def _load_daily_quotes(start: str, end_padded: str) -> pd.DataFrame:
    """加载 [start, end_padded] 区间的 daily_quote。end_padded 含 max_hold 缓冲。"""

    sql = text(
        """
        SELECT q.ts_code, q.trade_date, q.close
        FROM raw.daily_quote q
        WHERE q.trade_date >= :start AND q.trade_date <= :end
        ORDER BY q.ts_code, q.trade_date
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end_padded}).fetchall()
        if not rows:
            return pd.DataFrame(columns=["ts_code", "trade_date", "close"])
        df = pd.DataFrame(rows, columns=["ts_code", "trade_date", "close"])
        df["close"] = pd.to_numeric(df["close"], errors="coerce")
        return df
    except Exception as exc:  # noqa: BLE001
        logger.error("daily_quote_failed", extra={"err": str(exc)})
        raise


def _load_stk_limit(start: str, end: str) -> pd.DataFrame:
    sql = text(
        """
        SELECT ts_code, trade_date, up_limit, down_limit
        FROM raw.stk_limit
        WHERE trade_date >= :start AND trade_date <= :end
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            return pd.DataFrame(columns=["ts_code", "trade_date", "up_limit", "down_limit"])
        df = pd.DataFrame(rows, columns=["ts_code", "trade_date", "up_limit", "down_limit"])
        for c in ("up_limit", "down_limit"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        return df
    except Exception as exc:  # noqa: BLE001
        logger.error("stk_limit_failed", extra={"err": str(exc)})
        raise


def _load_suspend(start: str, end: str) -> pd.DataFrame:
    sql = text(
        """
        SELECT ts_code, trade_date
        FROM raw.suspend_d
        WHERE trade_date >= :start AND trade_date <= :end
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end}).fetchall()
        if not rows:
            logger.warning("suspend_d_empty", extra={"start": start, "end": end})
            return pd.DataFrame(columns=["ts_code", "trade_date"])
        return pd.DataFrame(rows, columns=["ts_code", "trade_date"])
    except Exception as exc:  # noqa: BLE001
        logger.error("suspend_d_failed", extra={"err": str(exc)})
        raise


def _load_listing_info() -> tuple[pd.DataFrame, pd.DataFrame]:
    """加载上市/退市信息（list_date / delist_date）。

    数据来源：public.a_share_symbols（NestJS syncSymbols 维护）。
    """

    sql = text(
        """
        SELECT ts_code, list_date, delist_date
        FROM public.a_share_symbols
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql).fetchall()
        if not rows:
            logger.error("a_share_symbols_empty")
            raise RuntimeError(
                "a_share_symbols returned 0 rows — cannot compute survivorship bias"
            )
        df = pd.DataFrame(rows, columns=["ts_code", "list_date", "delist_date"])
        listing = df[["ts_code", "list_date"]].dropna()
        delist = df[df["delist_date"].notna()][["ts_code", "delist_date"]]
        return listing, delist
    except Exception as exc:  # noqa: BLE001
        logger.error("stock_basic_failed", extra={"err": str(exc)})
        raise


# ----------------------------------------------------------------------
# upsert
# ----------------------------------------------------------------------

def _upsert_labels(rows: list[dict[str, Any]]) -> int:
    """按 PK (trade_date, ts_code, scheme) 去重后 upsert 到 factors.labels。"""

    if not rows:
        return 0
    seen: dict[tuple[str, str, str], dict[str, Any]] = {}
    for r in rows:
        key = (str(r["trade_date"]), str(r["ts_code"]), str(r["scheme"]))
        seen[key] = r
    deduped = list(seen.values())
    if len(deduped) != len(rows):
        logger.warning(
            "labels_dedup",
            extra={"raw": len(rows), "deduped": len(deduped)},
        )

    sql = text(
        """
        INSERT INTO factors.labels
            (trade_date, ts_code, scheme, value, exit_reason, hold_days)
        VALUES
            (:trade_date, :ts_code, :scheme, :value, :exit_reason, :hold_days)
        ON CONFLICT (trade_date, ts_code, scheme)
        DO UPDATE SET value       = EXCLUDED.value,
                      exit_reason = EXCLUDED.exit_reason,
                      hold_days   = EXCLUDED.hold_days
        """
    )
    with session_scope() as session:
        session.execute(sql, deduped)
    return len(deduped)


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------

def compute_labels(
    *,
    scheme: str,
    date_range: str,
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> int:
    """计算并 upsert 标签；返回写入的行数。

    参数：
        scheme:            "strategy-aware"（M2 暂仅支持）
        date_range:        "YYYYMMDD:YYYYMMDD"
        job_id:            可选，传入则在每日完成后写 progress
        progress_callback: 可选，CLI 终端进度条回调 (progress, stage) -> None
    """

    def _progress(progress: int, stage: str) -> None:
        if progress_callback is not None:
            progress_callback(progress, stage)
        if job_id is not None:
            update_progress(job_id, progress, stage=stage)

    if scheme not in (LABEL_SCHEME, SCHEME_FWD_5D_RET):
        raise NotImplementedError(
            f"labels scheme={scheme!r} not implemented in M2 "
            f"(supported: {LABEL_SCHEME!r}, {SCHEME_FWD_5D_RET!r})"
        )
    start, end = date_range.split(":")
    if len(start) != 8 or len(end) != 8:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")

    # 拉数据：报价需要往后多取 max_hold + 缓冲，让 simulate_exit 能完整模拟尾部入场
    end_padded_dt = pd.to_datetime(end, format="%Y%m%d") + pd.Timedelta(days=45)
    end_padded = end_padded_dt.strftime("%Y%m%d")

    quotes = _load_daily_quotes(start, end_padded)
    stk_limit = _load_stk_limit(start, end)
    suspend = _load_suspend(start, end_padded)
    listing, delist = _load_listing_info()

    if quotes.empty:
        logger.warning(
            "no_quotes_in_window",
            extra={"start": start, "end": end_padded},
        )
        return 0

    # 目标入场日范围内的 entries
    entries = quotes.loc[
        (quotes["trade_date"] >= start) & (quotes["trade_date"] <= end),
        ["ts_code", "trade_date"],
    ].copy()

    if job_id is not None and check_cancel_requested(job_id):
        raise JobCancelled
    _progress(10, "labels:load")

    if scheme == LABEL_SCHEME:
        labels_df = compute_strategy_aware_labels(
            LabelInputs(
                daily_quotes=quotes,
                stk_limit=stk_limit if not stk_limit.empty else None,
                suspend_d=suspend if not suspend.empty else None,
                delist=delist if not delist.empty else None,
                listing=listing if not listing.empty else None,
                entries=entries,
            ),
            progress_callback=_progress if progress_callback is not None else None,
        )
    else:
        # fwd_5d_ret 兜底（doc/04 §4.1）
        labels_df = compute_fwd_5d_ret(
            FallbackInputs(
                daily_quotes=quotes,
                suspended_set=derive_suspended_set(suspend if not suspend.empty else None),
                delist_map=derive_delist_map(delist if not delist.empty else None),
            )
        )
        labels_df = labels_df.loc[
            (labels_df["trade_date"] >= start) & (labels_df["trade_date"] <= end)
        ].reset_index(drop=True)
    _progress(60, "labels:compute")

    if labels_df.empty:
        logger.warning(
            "labels_empty",
            extra={"date_range": date_range, "scheme": scheme},
        )
        _progress(100, "labels:done")
        return 0

    rows = labels_df.to_dict("records")
    n = _upsert_labels(rows)

    _progress(100, "labels:done")
    logger.info(
        "labels_written",
        extra={"date_range": date_range, "scheme": scheme, "rows": n},
    )
    return n


def runner_entrypoint(job: object) -> None:
    """供 worker.dispatcher 调用。

    job.params schema（01-pg-schema §4.1）：
        {"scheme": "strategy-aware", "date_range": "YYYYMMDD:YYYYMMDD"}
    """

    params = getattr(job, "params", {}) or {}
    scheme = params.get("scheme")
    date_range = params.get("date_range")
    if not scheme or not date_range:
        raise ValueError(
            f"labels job missing required params: scheme/date_range, got {params!r}"
        )
    job_id = getattr(job, "id", None)
    compute_labels(
        scheme=str(scheme),
        date_range=str(date_range),
        job_id=job_id,
    )


__all__ = ["compute_labels", "runner_entrypoint"]
