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
from quant_pipeline.labels._common import (
    PROGRESS_COMPUTE_DONE,
    PROGRESS_DONE,
    PROGRESS_LOAD,
    apply_hfq,
    derive_delist_map,
    derive_suspended_set,
)
from quant_pipeline.labels.fallback import (
    FallbackInputs,
    SCHEME_FWD_5D_RET,
    compute_fwd_5d_ret,
)
from quant_pipeline.labels.strategy_aware import (
    LABEL_SCHEME,
    LabelInputs,
    compute_strategy_aware_labels,
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
    """加载 [start, end_padded] 区间的 daily_quote，并注入后复权列。

    JOIN raw.adj_factor 取复权因子；经 _common.apply_hfq 注入 close_adj/low_adj。
    返回列 [ts_code, trade_date, close, low, adj_factor, close_adj, low_adj]。
    end_padded 含 max_hold 缓冲。
    """

    sql = text(
        """
        SELECT q.ts_code, q.trade_date, q.close, q.low, a.adj_factor
        FROM raw.daily_quote q
        LEFT JOIN raw.adj_factor a
               ON a.ts_code = q.ts_code AND a.trade_date = q.trade_date
        WHERE q.trade_date >= :start AND q.trade_date <= :end
        ORDER BY q.ts_code, q.trade_date
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(sql, {"start": start, "end": end_padded}).fetchall()
        cols = ["ts_code", "trade_date", "close", "low", "adj_factor"]
        if not rows:
            return pd.DataFrame(columns=[*cols, "close_adj", "low_adj"])
        df = pd.DataFrame(rows, columns=cols)
        for c in ("close", "low", "adj_factor"):
            df[c] = pd.to_numeric(df[c], errors="coerce")
        return apply_hfq(df)
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
            logger.warning(
                "stk_limit_empty",
                extra={"start": start, "end": end,
                       "note": "stk_limit 为空 → 本次涨停过滤失效"},
            )
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


def _compute_end_padded(end: str, *, n_trade_days: int = 30) -> str:
    """按交易日历取 end 之后第 n_trade_days 个交易日作为 end_padded。

    缓冲需 > MAX_HOLD_DAYS(20) + T+1 入场偏移 + 余量，取 30 个交易日。
    数据来源 raw.trade_cal（is_open=1），参考 factors/runner._query_trade_dates。
    若 raw.trade_cal 在 end 之后不足 n_trade_days 个交易日（数据本身到期）→
    取能取到的最后一日并 logger.warning。
    """

    # cal_date / trade_date 均为 Tushare YYYYMMDD 定宽字符串，字典序即时序。
    sql = text(
        """
        SELECT cal_date FROM raw.trade_cal
        WHERE is_open = 1 AND cal_date > :end
        ORDER BY cal_date
        LIMIT :limit
        """
    )
    try:
        with session_scope() as session:
            rows = session.execute(
                sql, {"end": end, "limit": n_trade_days}
            ).fetchall()
    except Exception as exc:  # noqa: BLE001
        logger.error("trade_cal_failed", extra={"err": str(exc)})
        raise
    dates = [str(r[0]) for r in rows]
    if len(dates) < n_trade_days:
        logger.warning(
            "labels_end_padded_insufficient",
            extra={
                "end": end,
                "requested": n_trade_days,
                "available": len(dates),
            },
        )
        if not dates:
            return end
    return dates[-1]


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
    new_listing_min_days: int | None = None,
    job_id: UUID | None = None,
    progress_callback: ProgressCallback | None = None,
) -> int:
    """计算并 upsert 标签；返回写入的行数。

    参数：
        scheme:                "strategy-aware" / "fwd_5d_ret"
        date_range:            "YYYYMMDD:YYYYMMDD"
        new_listing_min_days:  新股门槛交易日阈值。None → 走默认 60；0 表示不过滤。
                               非法值由 _validate_min_days 抛 ValueError。
        job_id:                可选，传入则在每日完成后写 progress
        progress_callback:     可选，CLI 终端进度条回调 (progress, stage) -> None
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

    # 拉数据：报价需要往后多取 max_hold + 缓冲，让 simulate_exit 能完整模拟尾部入场。
    # end_padded 按交易日历取 end 之后第 30 个交易日（spec 03 §item-5）。
    end_padded = _compute_end_padded(end)

    quotes = _load_daily_quotes(start, end_padded)
    stk_limit = _load_stk_limit(start, end)
    suspend = _load_suspend(start, end_padded)
    listing, delist = _load_listing_info()

    if quotes.empty:
        # 窗口内一行 daily_quote 都没有 → 确凿数据缺口（CLAUDE.md 硬约束）
        raise RuntimeError(
            f"labels: no daily_quote rows in window "
            f"date_range={date_range!r} scheme={scheme!r} end_padded={end_padded!r}"
        )

    # 目标入场日范围内的 entries（信号日 T；trade_date 为 YYYYMMDD 定宽字符串，
    # 字典序即时序，可直接做字符串比较）
    entries = quotes.loc[
        (quotes["trade_date"] >= start) & (quotes["trade_date"] <= end),
        ["ts_code", "trade_date"],
    ].copy()

    if job_id is not None and check_cancel_requested(job_id):
        raise JobCancelled
    _progress(PROGRESS_LOAD, "labels:load")

    if scheme == LABEL_SCHEME:
        labels_df = compute_strategy_aware_labels(
            LabelInputs(
                daily_quotes=quotes,
                stk_limit=stk_limit if not stk_limit.empty else None,
                suspend_d=suspend if not suspend.empty else None,
                delist=delist if not delist.empty else None,
                listing=listing if not listing.empty else None,
                entries=entries,
                end=end,
                new_listing_min_days=new_listing_min_days,
            ),
            progress_callback=_progress if progress_callback is not None else None,
        )
        # compute_* 原始输出为空 → candidates 被过滤光 / 模拟全失败属真异常
        if labels_df.empty:
            raise RuntimeError(
                f"labels: compute_strategy_aware_labels produced 0 rows "
                f"date_range={date_range!r} scheme={scheme!r}"
            )
    else:
        # fwd_5d_ret 兜底（doc/04 §4.1）。listing 透传以支持新股过滤（D-1 缺口补齐）。
        labels_df = compute_fwd_5d_ret(
            FallbackInputs(
                daily_quotes=quotes,
                suspended_set=derive_suspended_set(suspend if not suspend.empty else None),
                delist_map=derive_delist_map(delist if not delist.empty else None),
                listing=listing if not listing.empty else None,
                new_listing_min_days=new_listing_min_days,
            )
        )
        # compute_* 原始输出（区间过滤前）为空 → 真异常
        if labels_df.empty:
            raise RuntimeError(
                f"labels: compute_fwd_5d_ret produced 0 rows "
                f"date_range={date_range!r} scheme={scheme!r}"
            )
        # 区间过滤（trade_date 为 YYYYMMDD 定宽字符串，字典序即时序）。
        # compute_fwd_5d_ret 用 end_padded 的 quotes，每票末 5 行被 shift 丢弃属正常；
        # 区间过滤之后合法地为空 → 仅 warning + return 0，不 raise。
        labels_df = labels_df.loc[
            (labels_df["trade_date"] >= start) & (labels_df["trade_date"] <= end)
        ].reset_index(drop=True)
    _progress(PROGRESS_COMPUTE_DONE, "labels:compute")

    if labels_df.empty:
        logger.warning(
            "labels_empty_after_range_filter",
            extra={"date_range": date_range, "scheme": scheme},
        )
        _progress(PROGRESS_DONE, "labels:done")
        return 0

    rows = labels_df.to_dict("records")
    n = _upsert_labels(rows)

    _progress(PROGRESS_DONE, "labels:done")
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
    # new_listing_min_days 可选；None 时由 compute_labels 走默认 60。
    # 校验由下游 _validate_min_days 抛 ValueError，worker 顶层捕获标记 job=failed。
    new_listing_min_days = params.get("new_listing_min_days")
    job_id = getattr(job, "id", None)
    compute_labels(
        scheme=str(scheme),
        date_range=str(date_range),
        new_listing_min_days=new_listing_min_days,
        job_id=job_id,
    )


__all__ = ["compute_labels", "runner_entrypoint"]
