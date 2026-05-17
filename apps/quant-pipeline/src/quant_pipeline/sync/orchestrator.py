"""sync 编排器：把 6 张表 sync 串联起来，并接入 worker.dispatcher。

设计：
- ml.jobs.params 形如：
    {
      "date_range": "20200101:20260517",
      "tables": ["trade_cal", "stk_limit", "suspend_d", "index_classify",
                 "index_member", "fina_indicator"],
      "fina_indicator": {"ts_codes": ["600000.SH", ...]}   # 可选
    }
- 表执行顺序固定（trade_cal 先行：其它表的"按交易日循环"需要它）；
- 每张表完成后写 progress
- 返回 SyncOutcome：含 errors / failedItems（包含 empty_path 的 SyncReport）
- 任一 fetcher 返回空数据时都计入 failedItems，apiName 标 `<table>_empty`，
  对齐 CLAUDE.md "fetcher 0 行必须显式 failedItems" 规则
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from typing import Any
from uuid import UUID

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync.fina_indicator import sync_fina_indicator_by_ts_code
from quant_pipeline.sync.index_classify import sync_index_classify
from quant_pipeline.sync.index_member import sync_index_member
from quant_pipeline.sync.stk_limit import sync_stk_limit_by_date
from quant_pipeline.sync.suspend import sync_suspend_by_date
from quant_pipeline.sync.trade_cal import SyncReport, sync_trade_cal
from quant_pipeline.sync.tushare_client import TushareClient
from quant_pipeline.worker.progress import (
    check_cancel_requested,
    update_progress,
    JobCancelled,
)

logger = logging.getLogger(__name__)


# 固定执行顺序：trade_cal 必须最先（其它表的按日循环依赖它）
DEFAULT_TABLES: tuple[str, ...] = (
    "trade_cal",
    "index_classify",
    "index_member",
    "stk_limit",
    "suspend_d",
    "fina_indicator",
)


@dataclass
class FailedItem:
    """fetcher 0 行 / 异常路径的失败条目（对齐 CLAUDE.md errors / failedItems 规范）。"""

    api_name: str
    table: str
    params: dict[str, Any]
    reason: str  # data_null / items_empty / code_nonzero / null_pk_dropped 等
    rule: str  # `<table>_empty`，前端 quality 看板可见


@dataclass
class SyncOutcome:
    rows_total: int = 0
    per_table_rows: dict[str, int] = field(default_factory=dict)
    failed_items: list[FailedItem] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)


def _parse_date_range(date_range: str) -> tuple[str, str]:
    if ":" not in date_range:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")
    start, end = date_range.split(":", 1)
    if len(start) != 8 or len(end) != 8 or not start.isdigit() or not end.isdigit():
        raise ValueError(f"date_range must be YYYYMMDD pair, got {date_range!r}")
    return start, end


def _list_open_trade_dates(start_date: str, end_date: str) -> list[str]:
    """从 raw.trade_cal 取 [start, end] 区间内 SSE is_open=1 的 cal_date。"""

    from sqlalchemy import text

    with session_scope() as session:
        rows = session.execute(
            text(
                """
                SELECT cal_date
                FROM raw.trade_cal
                WHERE exchange = 'SSE'
                  AND is_open = 1
                  AND cal_date BETWEEN :start AND :end
                ORDER BY cal_date
                """
            ),
            {"start": start_date, "end": end_date},
        ).all()
    return [r[0] for r in rows]


def _collect_reports(
    table: str, reports: list[SyncReport], outcome: SyncOutcome
) -> None:
    rows_sum = 0
    for r in reports:
        rows_sum += r.rows_upserted
        if r.empty_path is not None:
            outcome.failed_items.append(
                FailedItem(
                    api_name=r.api_name,
                    table=table,
                    params=r.params,
                    reason=r.empty_path,
                    rule=f"{table}_empty",
                )
            )
    outcome.per_table_rows[table] = outcome.per_table_rows.get(table, 0) + rows_sum
    outcome.rows_total += rows_sum


def run_sync(
    *,
    job_id: UUID | None,
    date_range: str,
    tables: tuple[str, ...] = DEFAULT_TABLES,
    fina_indicator_ts_codes: tuple[str, ...] | None = None,
    client: TushareClient | None = None,
) -> SyncOutcome:
    """同步 6 张表的入口。

    参数：
      job_id: 用于进度回写 / 取消检查；None 时 CLI 直跑（不写 ml.jobs）
      date_range: 'YYYYMMDD:YYYYMMDD'
      tables: 要同步的表（保留默认顺序约束）
      fina_indicator_ts_codes: 同步财务指标的股票列表；None 则跳过 fina_indicator
        ※ fina_indicator 必须按 ts_code 单股调用，不传 ts_codes 时跳过并 warn
    """

    start_date, end_date = _parse_date_range(date_range)
    client = client or TushareClient()
    outcome = SyncOutcome()
    total_steps = max(len(tables), 1)

    def _check_cancel() -> None:
        if job_id is not None and check_cancel_requested(job_id):
            raise JobCancelled

    def _progress(step_idx: int, stage: str) -> None:
        if job_id is None:
            return
        pct = int(step_idx * 100 / total_steps)
        update_progress(job_id, pct, stage=stage)

    if job_id is not None:
        update_progress(job_id, 0, stage="start")

    for step_idx, table in enumerate(tables):
        _check_cancel()
        try:
            if table == "trade_cal":
                reports = sync_trade_cal(
                    start_date=start_date, end_date=end_date, client=client
                )
                _collect_reports("trade_cal", reports, outcome)

            elif table == "index_classify":
                reports = sync_index_classify(client=client)
                _collect_reports("index_classify", reports, outcome)

            elif table == "index_member":
                reports = sync_index_member(client=client)
                _collect_reports("index_member", reports, outcome)

            elif table in ("stk_limit", "suspend_d"):
                # 按 raw.trade_cal 取开市日循环
                open_dates = _list_open_trade_dates(start_date, end_date)
                if not open_dates:
                    outcome.failed_items.append(
                        FailedItem(
                            api_name=table,
                            table=table,
                            params={"date_range": date_range},
                            reason="no_open_trade_dates",
                            rule=f"{table}_empty",
                        )
                    )
                    continue
                for td in open_dates:
                    _check_cancel()
                    if table == "stk_limit":
                        rep = sync_stk_limit_by_date(trade_date=td, client=client)
                    else:
                        rep = sync_suspend_by_date(trade_date=td, client=client)
                    _collect_reports(table, [rep], outcome)

            elif table == "fina_indicator":
                if not fina_indicator_ts_codes:
                    logger.warning(
                        "fina_indicator_skipped_no_ts_codes",
                        extra={"reason": "params.fina_indicator.ts_codes 未传"},
                    )
                    outcome.failed_items.append(
                        FailedItem(
                            api_name="fina_indicator",
                            table="fina_indicator",
                            params={},
                            reason="no_ts_codes",
                            rule="fina_indicator_empty",
                        )
                    )
                    continue
                for ts_code in fina_indicator_ts_codes:
                    _check_cancel()
                    rep = sync_fina_indicator_by_ts_code(
                        ts_code=ts_code,
                        start_date=start_date,
                        end_date=end_date,
                        client=client,
                    )
                    _collect_reports("fina_indicator", [rep], outcome)

            else:
                outcome.errors.append(f"unknown table: {table!r}")
                continue

        except JobCancelled:
            raise
        except Exception as exc:  # noqa: BLE001 —— 单表失败不中断后续，但显式 errors
            logger.error(
                "sync_table_failed",
                extra={"table": table, "err": str(exc)},
            )
            outcome.errors.append(f"{table}: {exc!r}")

        _progress(step_idx + 1, stage=f"done:{table}")

    if job_id is not None:
        update_progress(job_id, 100, stage="done")
    return outcome
