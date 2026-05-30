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

from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.sync.fina_indicator import sync_fina_indicator_by_ts_code
from quant_pipeline.sync.index_classify import sync_index_classify
from quant_pipeline.sync.index_member import sync_index_member
from quant_pipeline.sync.stk_limit import sync_stk_limit_by_date
from quant_pipeline.sync.suspend import sync_suspend_by_date
from quant_pipeline.sync.trade_cal import SyncReport, sync_trade_cal
from quant_pipeline.sync.tushare_client import TushareClient
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)


# index_member_all 单次行数上限：index_member.py docstring 记「2000 行」、
# orchestrator._list_l1_codes_from_classify docstring 记「实测 3000 行截断」——
# 两处不一致（见 review 01-sync 第 7 条，需后续以官方文档为准统一）。
# 此处取保守下界 2000：兜底单次全量调用行数 >= 该值即视为可疑截断。
INDEX_MEMBER_TRUNCATE_THRESHOLD = 2000


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


def _list_l1_codes_from_classify() -> list[str]:
    """从 raw.index_classify 取申万一级（SW2021 source）的 index_code 列表。

    TuShare `index_member_all` 默认单次调用受行数上限（实测 3000 行截断），
    全 A ~5300 股 + 多行业层级数据量远超上限。本函数返回 31 个 L1 code，
    由 orchestrator 传给 sync_index_member 按 L1 分批 fetch（每 L1 行业
    成份股 ~150-200 行，远低于单次上限）。

    表为空时返回 []，调用方应退化为单次全量调用（向后兼容）。
    """

    with session_scope() as session:
        rows = session.execute(
            text(
                """
                SELECT DISTINCT index_code
                FROM raw.index_classify
                WHERE level = 'L1' AND src = 'SW2021'
                ORDER BY index_code
                """
            )
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

    def _sub_progress(step_idx: int, done: int, total: int, stage: str) -> None:
        """按交易日 / ts_code 循环内的子进度。

        把当前 step（占 1/total_steps）内的 done/total 比例插值进总进度，
        避免长循环（stk_limit 约 1400 个交易日 / fina_indicator 5000+ 只股票）
        期间进度条卡死不动。
        """

        if job_id is None or total <= 0:
            return
        step_span = 100 / total_steps
        pct = int(step_idx * step_span + step_span * done / total)
        update_progress(job_id, min(pct, 100), stage=stage)

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
                # 按 raw.index_classify 的 L1 code 列表分批 fetch；
                # 避免 TuShare index_member_all 单次行数上限截断（c8 修复）
                l1_codes = _list_l1_codes_from_classify()
                if l1_codes:
                    reports = sync_index_member(
                        client=client, l1_codes=tuple(l1_codes)
                    )
                    _collect_reports("index_member", reports, outcome)
                else:
                    # 兜底：index_classify 未就绪时退化为单次全量调用
                    logger.warning(
                        "index_member_fallback_single_call",
                        extra={"reason": "raw.index_classify 无 L1 行业；可能导致单次行数上限截断"},
                    )
                    reports = sync_index_member(client=client)
                    _collect_reports("index_member", reports, outcome)
                    # 单次全量调用可能命中 index_member_all 单次行数上限被静默截断。
                    # 行数命中阈值即标记为可疑截断的 failed_item，避免残缺数据静默通过。
                    fallback_rows = sum(r.rows_upserted for r in reports)
                    if fallback_rows >= INDEX_MEMBER_TRUNCATE_THRESHOLD:
                        outcome.failed_items.append(
                            FailedItem(
                                api_name="index_member_all",
                                table="index_member",
                                params={"mode": "fallback_single_call"},
                                reason="index_member_truncated_suspect",
                                rule="index_member_empty",
                            )
                        )
                        logger.warning(
                            "index_member_truncated_suspect",
                            extra={
                                "rows": fallback_rows,
                                "threshold": INDEX_MEMBER_TRUNCATE_THRESHOLD,
                            },
                        )

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
                total_dates = len(open_dates)
                for i, td in enumerate(open_dates):
                    _check_cancel()
                    if table == "stk_limit":
                        rep = sync_stk_limit_by_date(trade_date=td, client=client)
                    else:
                        rep = sync_suspend_by_date(trade_date=td, client=client)
                    _collect_reports(table, [rep], outcome)
                    # 每 20 个交易日刷一次子进度，避免长循环进度条卡死
                    if (i + 1) % 20 == 0 or (i + 1) == total_dates:
                        _sub_progress(
                            step_idx, i + 1, total_dates,
                            stage=f"{table}:{td}",
                        )

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
                total_codes = len(fina_indicator_ts_codes)
                for i, ts_code in enumerate(fina_indicator_ts_codes):
                    _check_cancel()
                    rep = sync_fina_indicator_by_ts_code(
                        ts_code=ts_code,
                        start_date=start_date,
                        end_date=end_date,
                        client=client,
                    )
                    _collect_reports("fina_indicator", [rep], outcome)
                    # 每 20 只股票刷一次子进度（全 A 5000+ 只串行循环耗时长）
                    if (i + 1) % 20 == 0 or (i + 1) == total_codes:
                        _sub_progress(
                            step_idx, i + 1, total_codes,
                            stage=f"fina_indicator:{ts_code}",
                        )

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
