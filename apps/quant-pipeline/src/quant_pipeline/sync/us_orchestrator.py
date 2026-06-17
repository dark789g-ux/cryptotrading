"""美股同步编排器：遍历 tracked ticker → 抓行情/因子/指标，CLI 与 worker 共用入口。

run_type='us_sync'（spec 01/04）。逐 ticker：
- 单次抓 Yahoo 日线（含 adj_close）→ us_daily_quote / us_adj_factor / us_daily_indicator
- 空数据 / 因子缺失 → failed_items（apiName us_daily_empty / us_factor_empty），不静默
- 异常逐 ticker 捕获记 errors，不中断整批
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from quant_pipeline.sync.yahoo_client import YahooClient
from quant_pipeline.sync.us_daily import sync_us_daily_for_ticker
from quant_pipeline.sync.us_symbol import list_tracked_tickers
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)


@dataclass
class UsFailedItem:
    ticker: str
    api_name: str
    reason: str
    rule: str  # us_daily_empty / us_factor_empty


@dataclass
class UsSyncOutcome:
    quote_rows_total: int = 0
    factor_rows_total: int = 0
    indicator_rows_total: int = 0
    tickers_done: int = 0
    failed_items: list[UsFailedItem] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _parse_date_range(date_range: str) -> tuple[str, str]:
    if ":" not in date_range:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")
    start, end = date_range.split(":", 1)
    if len(start) != 8 or len(end) != 8 or not start.isdigit() or not end.isdigit():
        raise ValueError(f"date_range must be YYYYMMDD pair, got {date_range!r}")
    return start, end


def run_us_sync(
    *,
    job_id: UUID | None,
    date_range: str,
    tickers: tuple[str, ...] | None = None,
    client: YahooClient | None = None,
) -> UsSyncOutcome:
    """美股同步入口。

    job_id=None → CLI 直跑（不写 ml.jobs）；否则回写进度。
    tickers=None → 取 raw.us_symbol where tracked。
    """

    start_date, end_date = _parse_date_range(date_range)
    client = client or YahooClient()
    outcome = UsSyncOutcome()

    ticker_list = list(tickers) if tickers else list_tracked_tickers()
    if not ticker_list:
        logger.warning("us_sync_no_tickers", extra={"date_range": date_range})
        outcome.errors.append("no tracked tickers (raw.us_symbol where tracked) and none passed")
        if job_id is not None:
            update_progress(job_id, 100, stage="done")
        return outcome

    total = len(ticker_list)
    if job_id is not None:
        update_progress(job_id, 0, stage="start")

    for i, ticker in enumerate(ticker_list):
        if job_id is not None and check_cancel_requested(job_id):
            raise JobCancelled
        try:
            rep = sync_us_daily_for_ticker(
                ticker=ticker, start_date=start_date, end_date=end_date, client=client
            )
            outcome.quote_rows_total += rep.quote_rows
            outcome.factor_rows_total += rep.factor_rows
            outcome.indicator_rows_total += rep.indicator_rows
            outcome.tickers_done += 1
            if rep.empty_path is not None:
                outcome.failed_items.append(
                    UsFailedItem(ticker=ticker, api_name="yahoo_chart",
                                 reason=rep.empty_path, rule="us_daily_empty")
                )
            elif rep.factor_empty:
                outcome.failed_items.append(
                    UsFailedItem(ticker=ticker, api_name="yahoo_chart(adj_close)",
                                 reason="factor_unavailable", rule="us_factor_empty")
                )
        except JobCancelled:
            raise
        except Exception as exc:  # noqa: BLE001 — 单 ticker 失败不中断整批, 但显式 errors
            logger.error("us_sync_ticker_failed", extra={"ticker": ticker, "err": str(exc)})
            outcome.errors.append(f"{ticker}: {exc!r}")

        if job_id is not None and ((i + 1) % 3 == 0 or (i + 1) == total):
            update_progress(job_id, int((i + 1) * 100 / total), stage=f"us_sync:{ticker}")

    if job_id is not None:
        update_progress(job_id, 100, stage="done")
    return outcome
