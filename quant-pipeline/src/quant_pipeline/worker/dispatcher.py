"""Dispatcher：把 Job 路由到对应 runner。

M0 阶段仅实现 run_type='noop'（直接 success 0→100）；其它 run_type 一律
status='failed' + error_text='not implemented in M0'。
"""

from __future__ import annotations

import logging
import traceback
from typing import Any
from uuid import UUID

from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.worker.poller import Job
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    update_progress,
)

logger = logging.getLogger(__name__)


# ----------------------------------------------------------------------
# Runner contract（M0）
# ----------------------------------------------------------------------

def _runner_noop(job: Job) -> None:
    """noop runner：写 progress 0 → 50 → 100。验证消费链路。"""

    update_progress(job.id, 0, stage="start")
    if check_cancel_requested(job.id):
        raise JobCancelled
    update_progress(job.id, 50, stage="mid")
    if check_cancel_requested(job.id):
        raise JobCancelled
    update_progress(job.id, 100, stage="done")


def _runner_not_implemented(job: Job) -> None:
    raise NotImplementedError(f"run_type={job.run_type!r} not implemented in M0")


# run_type → runner 路由表
_ROUTES = {
    "noop": _runner_noop,
    # M1+
    "sync": _runner_not_implemented,
    "quality": _runner_not_implemented,
    "factors": _runner_not_implemented,
    "labels": _runner_not_implemented,
    "features": _runner_not_implemented,
    "train": _runner_not_implemented,
    "infer": _runner_not_implemented,
    "optuna": _runner_not_implemented,
    "seed_avg": _runner_not_implemented,
}


# ----------------------------------------------------------------------
# Job 终态写入助手
# ----------------------------------------------------------------------

def _finalize_job(
    job_id: UUID,
    *,
    status: str,
    progress: int = 100,
    error_text: str | None = None,
    blocked_reason: str | None = None,
) -> None:
    with session_scope() as session:
        session.execute(
            text(
                """
                UPDATE ml.jobs
                SET status         = :status,
                    progress       = :progress,
                    error_text     = :error_text,
                    blocked_reason = :blocked_reason,
                    finished_at    = now(),
                    heartbeat_at   = now()
                WHERE id = :job_id
                """
            ),
            {
                "status": status,
                "progress": progress,
                "error_text": error_text,
                "blocked_reason": blocked_reason,
                "job_id": job_id,
            },
        )


# ----------------------------------------------------------------------
# Dispatcher
# ----------------------------------------------------------------------

class Dispatcher:
    """单进程内的 dispatcher：拿到 Job 后调对应 runner，统一处理终态。"""

    def dispatch(self, job: Job) -> None:
        logger.info(
            "dispatch",
            extra={"job_id": str(job.id), "run_type": job.run_type, "attempts": job.attempts},
        )
        runner = _ROUTES.get(job.run_type)
        if runner is None:
            _finalize_job(
                job.id,
                status="failed",
                error_text=f"unknown run_type: {job.run_type!r}",
            )
            return

        try:
            runner(job)
        except JobCancelled:
            logger.info("job_cancelled", extra={"job_id": str(job.id)})
            _finalize_job(job.id, status="cancelled")
        except NotImplementedError as exc:
            # M0 占位：明确告知尚未实现
            logger.warning(
                "run_type_not_implemented",
                extra={"job_id": str(job.id), "run_type": job.run_type},
            )
            _finalize_job(
                job.id,
                status="failed",
                error_text=f"not implemented in M0: {exc}",
            )
        except Exception as exc:  # noqa: BLE001 —— 任何未捕获异常须落 error_text（04 §1）
            tb = traceback.format_exc()
            logger.error(
                "job_failed",
                extra={"job_id": str(job.id), "run_type": job.run_type, "err": str(exc)},
            )
            _finalize_job(job.id, status="failed", error_text=tb)
        else:
            _finalize_job(job.id, status="success", progress=100)


# ----------------------------------------------------------------------
# Reaper（02-quant-pipeline.md §4 + 00-index.md §3）
# ----------------------------------------------------------------------

def reap_stale_running_jobs(stale_minutes: int = 3) -> int:
    """回收 heartbeat 超时的 running 行；返回被回收的行数。

    规则：status='running' AND heartbeat_at < now() - interval '<stale> min'
      - attempts < max_attempts → 重置为 pending（reaper 自加 attempts 由下一次 poll 完成）
      - 否则 → status='failed' + error_text='heartbeat_timeout'
    """

    sql = text(
        f"""
        WITH stale AS (
            SELECT id, attempts, max_attempts
            FROM ml.jobs
            WHERE status = 'running'
              AND heartbeat_at < now() - interval '{int(stale_minutes)} min'
            FOR UPDATE SKIP LOCKED
        ),
        retry AS (
            UPDATE ml.jobs j
            SET status       = 'pending',
                heartbeat_at = NULL,
                started_at   = NULL
            FROM stale s
            WHERE j.id = s.id
              AND s.attempts < s.max_attempts
            RETURNING j.id
        ),
        giveup AS (
            UPDATE ml.jobs j
            SET status      = 'failed',
                error_text  = 'heartbeat_timeout',
                finished_at = now()
            FROM stale s
            WHERE j.id = s.id
              AND s.attempts >= s.max_attempts
            RETURNING j.id
        )
        SELECT (SELECT count(*) FROM retry) + (SELECT count(*) FROM giveup) AS reaped
        """
    )
    with session_scope() as session:
        row = session.execute(sql).first()
        count = int(row[0]) if row else 0
    if count:
        logger.warning("reaper_reaped", extra={"reaped": count})
    return count


# Convenience for unit tests: expose route table
def get_routes() -> dict[str, Any]:
    return dict(_ROUTES)
