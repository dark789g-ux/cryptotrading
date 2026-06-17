"""美股指数同步编排器：遍历指数 symbol → 抓行情/指标，CLI 与 worker 共用入口。

run_type='us_index_sync'（spec 03）。镜像 run_us_sync 但更简单：
- 单次抓取 → us_index_daily / us_index_indicator（无 qfq、无 adj_factor）
- 空数据 / 0 行 → failed_items（rule us_index_empty），不静默
- 异常逐 symbol 捕获记 errors，不中断整批
- symbols 缺省 = ('.NDX',)：v1 硬编码，无 catalog/tracked 查询
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from uuid import UUID

from quant_pipeline.sync.yahoo_client import YahooClient
from quant_pipeline.sync.us_index import sync_us_index_for_symbol
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)

DEFAULT_INDEX_SYMBOLS: tuple[str, ...] = (".NDX",)


@dataclass
class UsIndexFailedItem:
    index_code: str
    api_name: str
    reason: str
    rule: str  # us_index_empty


@dataclass
class UsIndexSyncOutcome:
    rows_total: int = 0
    indicator_rows_total: int = 0
    symbols_done: int = 0
    failed_items: list[UsIndexFailedItem] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _parse_date_range(date_range: str) -> tuple[str, str]:
    if ":" not in date_range:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")
    start, end = date_range.split(":", 1)
    if len(start) != 8 or len(end) != 8 or not start.isdigit() or not end.isdigit():
        raise ValueError(f"date_range must be YYYYMMDD pair, got {date_range!r}")
    return start, end


def run_us_index_sync(
    *,
    job_id: UUID | None,
    date_range: str,
    symbols: tuple[str, ...] | None = None,
    client: YahooClient | None = None,
    write_start: str | None = None,
) -> UsIndexSyncOutcome:
    """美股指数同步入口。

    job_id=None → CLI 直跑（不写 ml.jobs）；否则回写进度。
    symbols=None → 缺省 ('.NDX',)（v1 硬编码，无 catalog/tracked 查询）。
    write_start（spec 04 约束B）：默认 None → 等于 date_range 的 start（行为不变）；
    透传给 sync_us_index_for_symbol，仅写 trade_date >= write_start 的行。
    """

    start_date, end_date = _parse_date_range(date_range)
    client = client or YahooClient()
    outcome = UsIndexSyncOutcome()

    symbol_list = list(symbols) if symbols else list(DEFAULT_INDEX_SYMBOLS)

    total = len(symbol_list)
    if job_id is not None:
        update_progress(job_id, 0, stage="start")

    for i, index_code in enumerate(symbol_list):
        if job_id is not None and check_cancel_requested(job_id):
            raise JobCancelled
        try:
            rep = sync_us_index_for_symbol(
                index_code=index_code, start_date=start_date, end_date=end_date,
                client=client, write_start=write_start,
            )
            outcome.rows_total += rep.rows
            outcome.indicator_rows_total += rep.indicator_rows
            outcome.symbols_done += 1
            if rep.empty_path is not None:
                outcome.failed_items.append(
                    UsIndexFailedItem(
                        index_code=index_code,
                        api_name="yahoo_chart(index)",
                        reason=rep.empty_path,
                        rule="us_index_empty",
                    )
                )
        except JobCancelled:
            raise
        except Exception as exc:  # noqa: BLE001 — 单 symbol 失败不中断整批, 但显式 errors
            logger.error(
                "us_index_sync_symbol_failed",
                extra={"index_code": index_code, "err": str(exc)},
            )
            outcome.errors.append(f"{index_code}: {exc!r}")

        if job_id is not None and ((i + 1) % 3 == 0 or (i + 1) == total):
            update_progress(
                job_id, int((i + 1) * 100 / total), stage=f"us_index_sync:{index_code}"
            )

    if job_id is not None:
        update_progress(job_id, 100, stage="done")
    return outcome
