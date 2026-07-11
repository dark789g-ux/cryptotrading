"""美股一键同步编排器（spec 2026-06-17-us-sync-tab，子文档 03）。

把三步美股同步串成一条 worker job：
  step1 us-stocks       run_us_sync       tracked 全集
  step2 us-index-daily  run_us_index_sync .NDX
  step3 us-index-amv    run_us_index_amv_sync .NDX

设计要点（spec 03 + 01 + 04）：
- 每步对子调用传真实 job_id + _suppress_progress=True：子 orchestrator 可在逐 ticker/
  逐 symbol 粒度 check_cancel_requested，但**不写进度**（update_progress），由本编排器
  **独占** update_progress + result_payload。
- 抓取窗口 = ``[US_RETENTION_START, capped_end]``（全史 warmup 恒满，spec 04 约束B）；
  写库窗口 = ``[user_start, capped_end]``（透传 write_start=user_start）。
- ``capped_end = cap_to_last_closed_session(user_end)``（spec 04 约束A，丢在长 bar）。
- result_payload 增量写：内存维护 dict，每次步骤态变化 / 追加日志后整对象覆盖写库
  （update_job_result_partial）。schema 严格对齐 spec 01「result_payload 步骤态 schema」
  （前后端硬契约，前端 stores/usOneClickSync.ts 已按此读）。
- 时间戳一律 epoch ms 整数（前端按数字减法算 elapsed）。
- 失败不中断：每步 try/except，子调用抛硬异常 → 该步 status=failed + 记 error + 继续下一步。
  但 JobCancelled 异常会直接冒泡（不吞掉），让 dispatcher 置 cancelled。
- 取消：每步开始前 check_cancel_requested(job_id) → True 抛 JobCancelled（抛前把
  result_payload 写一次：cancelled=true、未完成步 skipped）。
- 致命错误（date_range 非法）→ 抛异常让 dispatcher 置 failed。
"""

from __future__ import annotations

import logging
import time
from typing import Any
from uuid import UUID

from quant_pipeline.sync.us_index_amv_orchestrator import run_us_index_amv_sync
from quant_pipeline.sync.us_index_orchestrator import run_us_index_sync
from quant_pipeline.sync.us_orchestrator import run_us_sync
from quant_pipeline.sync.us_session import cap_to_last_closed_session
from quant_pipeline.worker.dispatcher import update_job_result_partial
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)

# 美股保留起点（spec 04：min trade_date 实测 20240102）。抓取恒从此起点，warmup 恒满。
US_RETENTION_START = "20240102"

# 三步固定 key / 序（与前端 US_STEP_KEYS 同序，oneClickSync.types.ts ✅已核）。
STEP_US_STOCKS = "us-stocks"
STEP_US_INDEX_DAILY = "us-index-daily"
STEP_US_INDEX_AMV = "us-index-amv"
_STEP_KEYS: tuple[str, ...] = (STEP_US_STOCKS, STEP_US_INDEX_DAILY, STEP_US_INDEX_AMV)

# logs 防 jsonb 膨胀上限（spec 01：≤200，超出丢弃最旧）。
_LOG_LIMIT = 200


def _parse_date_range(date_range: str) -> tuple[str, str]:
    """解析 'YYYYMMDD:YYYYMMDD'（仿现有 us_orchestrator._parse_date_range）。

    非法 → ValueError（致命错误，由 dispatcher 置 failed）。
    """
    if ":" not in date_range:
        raise ValueError(f"date_range must be 'YYYYMMDD:YYYYMMDD', got {date_range!r}")
    start, end = date_range.split(":", 1)
    if len(start) != 8 or len(end) != 8 or not start.isdigit() or not end.isdigit():
        raise ValueError(f"date_range must be YYYYMMDD pair, got {date_range!r}")
    return start, end


def _now_ms() -> int:
    """epoch ms 整数（前端按数字减法算 elapsed，spec 01）。"""
    return int(time.time() * 1000)


def _empty_step(step: str) -> dict[str, Any]:
    """pending 初始步（形态对齐 spec 01 steps[] + 前端 emptyUsStep）。"""
    return {
        "step": step,
        "status": "pending",
        "percent": 0,
        "rowsWritten": 0,
        "phase": "",
        "message": "",
        "errors": [],
        "startedAt": None,
        "finishedAt": None,
    }


class _PayloadState:
    """内存维护 result_payload + 每次变更整对象覆盖写库（spec 03 增量写）。"""

    def __init__(self, job_id: UUID, *, user_start: str, user_end: str, capped_end: str):
        self._job_id = job_id
        self.payload: dict[str, Any] = {
            "version": 1,
            "range": {"start": user_start, "end": user_end, "cappedEnd": capped_end},
            "startedAt": _now_ms(),
            "finishedAt": None,
            "cancelled": False,
            "steps": [_empty_step(k) for k in _STEP_KEYS],
            "logs": [],
        }

    def _step(self, step: str) -> dict[str, Any]:
        return next(s for s in self.payload["steps"] if s["step"] == step)

    def log(self, step: str, level: str, text: str) -> None:
        """追加一条日志（LogEntry，spec 01），保留最近 ≤200 条。"""
        self.payload["logs"].append(
            {"ts": _now_ms(), "step": step, "level": level, "text": text}
        )
        if len(self.payload["logs"]) > _LOG_LIMIT:
            # 丢弃最旧，保留最近 _LOG_LIMIT 条
            self.payload["logs"] = self.payload["logs"][-_LOG_LIMIT:]

    def patch_step(self, step: str, **fields: Any) -> None:
        self._step(step).update(fields)

    def add_step_error(
        self, step: str, *, level: str, message: str, api_name: str | None = None
    ) -> None:
        """追加 OneClickErrorItem（spec 01：{step, level, apiName?, message}）。"""
        self._step(step)["errors"].append(
            {"step": step, "level": level, "apiName": api_name, "message": message}
        )

    def flush(self) -> None:
        """整对象覆盖写库（节流：3 步频率低，每次 patch 即写）。"""
        update_job_result_partial(self._job_id, self.payload)

    def finalize(self) -> None:
        self.payload["finishedAt"] = _now_ms()
        self.flush()

    def mark_remaining_skipped(self) -> None:
        """把未完成（pending/running）的步标 skipped（取消时调用）。"""
        for s in self.payload["steps"]:
            if s["status"] in ("pending", "running"):
                s["status"] = "skipped"
                if s["finishedAt"] is None:
                    s["finishedAt"] = _now_ms()


def _check_cancel(job_id: UUID, state: _PayloadState) -> None:
    """每步开始前检查取消：True → 写 cancelled 态后抛 JobCancelled。"""
    if not check_cancel_requested(job_id):
        return
    state.payload["cancelled"] = True
    state.mark_remaining_skipped()
    state.log("us-stocks", "warn", "收到取消请求，停止后续步骤")
    state.finalize()
    raise JobCancelled


def _map_failed_items(state: _PayloadState, step: str, failed_items: list[Any]) -> None:
    """failed_items（dataclass，含 rule / reason / ticker 等）→ step.errors[]（level=warn）。

    apiName 取 ``rule``（如 us_daily_empty，对齐 spec 01 示例）。message 含定位上下文。
    """
    for fi in failed_items:
        ticker = getattr(fi, "ticker", None)
        index_code = getattr(fi, "index_code", None)
        reason = getattr(fi, "reason", "")
        rule = getattr(fi, "rule", None)
        api_name = getattr(fi, "api_name", None)
        loc = ticker or index_code or "?"
        if index_code and ticker:
            loc = f"{index_code}/{ticker}"
        msg = f"{loc}: {reason} (api={api_name})"
        state.add_step_error(step, level="warn", message=msg, api_name=rule)


def _map_errors(state: _PayloadState, step: str, errors: list[str]) -> None:
    """errors（plain str，逐 ticker/symbol 异常）→ step.errors[]（level=error，无 apiName）。"""
    for err in errors:
        state.add_step_error(step, level="error", message=str(err))


def _run_step(
    job_id: UUID,
    state: _PayloadState,
    *,
    step: str,
    base: int,
    fn: Any,
    rows_attr: str,
    start_log: str,
    **fn_kwargs: Any,
) -> None:
    """跑单步：check_cancel → running → 调子 orchestrator（传真实 job_id，抑制子进度写入）→ 映射 outcome。

    失败不中断：fn 抛硬异常 → 该步 failed + 记 error（不向上抛，编排器继续下一步）。
    但 JobCancelled 直接冒泡（不吞掉），让 dispatcher 置 cancelled。
    """
    _check_cancel(job_id, state)

    update_progress(job_id, base, stage=step)
    state.patch_step(step, status="running", percent=0, startedAt=_now_ms())
    state.log(step, "info", start_log)
    state.flush()

    try:
        outcome = fn(job_id=job_id, _suppress_progress=True, **fn_kwargs)
    except JobCancelled:
        raise
    except Exception as exc:  # noqa: BLE001 — 单步失败不中断整链，但显式 error 透出
        logger.error(
            "us_one_click_step_failed",
            extra={"job_id": str(job_id), "step": step, "err": str(exc)},
        )
        state.patch_step(step, status="failed", finishedAt=_now_ms())
        state.add_step_error(step, level="error", message=f"{step} 失败: {exc!r}")
        state.log(step, "error", f"步骤失败：{exc!r}")
        update_progress(job_id, base + 33, stage=step)
        state.flush()
        return

    rows = int(getattr(outcome, rows_attr, 0) or 0)
    failed_items = list(getattr(outcome, "failed_items", []) or [])
    errors = list(getattr(outcome, "errors", []) or [])

    _map_failed_items(state, step, failed_items)
    _map_errors(state, step, errors)

    for fi in failed_items:
        loc = getattr(fi, "ticker", None) or getattr(fi, "index_code", None) or "?"
        state.log(step, "warn", f"{loc}: {getattr(fi, 'reason', '')}")
    for err in errors:
        state.log(step, "error", str(err))

    state.patch_step(
        step,
        status="success",
        percent=100,
        rowsWritten=rows,
        finishedAt=_now_ms(),
        message=f"写入 {rows} 行" + (f"，{len(failed_items) + len(errors)} 项异常"
                                    if (failed_items or errors) else ""),
    )
    state.log(step, "info", f"步骤完成：写入 {rows} 行")
    update_progress(job_id, base + 33, stage=step)
    state.flush()


def run_us_one_click_sync(*, job_id: UUID, date_range: str) -> None:
    """美股一键同步入口（worker dispatcher 路由 us_one_click_sync 调用）。

    顺序跑三步；失败不中断、取消抛 JobCancelled、致命错误（date_range 非法）抛异常。
    进度 0→33→66→100，stage 写步名；result_payload 增量写（前端轮询读）。
    """
    user_start, user_end = _parse_date_range(date_range)  # 致命错误：非法 → ValueError
    capped_end = cap_to_last_closed_session(user_end)
    fetch_range = f"{US_RETENTION_START}:{capped_end}"

    state = _PayloadState(
        job_id, user_start=user_start, user_end=user_end, capped_end=capped_end
    )
    state.log(STEP_US_STOCKS, "info", f"美股一键同步开始：窗口 [{user_start}, {capped_end}]")
    state.flush()

    # step1 美股个股（tracked 全集）
    _run_step(
        job_id, state,
        step=STEP_US_STOCKS, base=0, fn=run_us_sync,
        rows_attr="quote_rows_total",
        start_log="开始美股个股同步（tracked 全集）",
        date_range=fetch_range, tickers=None, write_start=user_start,
    )

    # step2 美股指数日线（.NDX）
    _run_step(
        job_id, state,
        step=STEP_US_INDEX_DAILY, base=33, fn=run_us_index_sync,
        rows_attr="rows_total",
        start_log="开始美股指数日线同步（.NDX）",
        date_range=fetch_range, symbols=None, write_start=user_start,
    )

    # step3 美股指数 AMV（.NDX）
    _run_step(
        job_id, state,
        step=STEP_US_INDEX_AMV, base=66, fn=run_us_index_amv_sync,
        rows_attr="amv_rows_total",
        start_log="开始美股指数 AMV 同步（.NDX）",
        date_range=fetch_range, symbols=None, write_start=user_start,
    )

    update_progress(job_id, 100, stage="done")
    state.finalize()
