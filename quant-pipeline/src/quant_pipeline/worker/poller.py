"""Poller：FOR UPDATE SKIP LOCKED 抓一行 pending job。

并发安全约束（04-error-quality-testing.md §1）：
    SELECT ... FROM ml.jobs
    WHERE status='pending'
    ORDER BY priority ASC, created_at ASC
    FOR UPDATE SKIP LOCKED LIMIT 1

返回 job 元组并在同一事务内把它置为 running + 写 started_at。
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Any
from uuid import UUID

from sqlalchemy import text

from quant_pipeline.db.engine import session_scope


@dataclass(frozen=True)
class Job:
    """从 ml.jobs 取出的最小字段集合（M0）。"""

    id: UUID
    run_type: str
    params: dict[str, Any]
    attempts: int
    max_attempts: int


def poll_one() -> Job | None:
    """抓一行 pending job 并 atomically 置为 running。

    无 pending 时返回 None。
    """

    sql_select = text(
        """
        SELECT id, run_type, params, attempts, max_attempts
        FROM ml.jobs
        WHERE status = 'pending'
        ORDER BY priority ASC, created_at ASC
        FOR UPDATE SKIP LOCKED
        LIMIT 1
        """
    )
    sql_update = text(
        """
        UPDATE ml.jobs
        SET status        = 'running',
            started_at    = now(),
            heartbeat_at  = now(),
            attempts      = attempts + 1
        WHERE id = :job_id
        """
    )

    with session_scope() as session:
        row = session.execute(sql_select).mappings().first()
        if row is None:
            return None
        session.execute(sql_update, {"job_id": row["id"]})
        return Job(
            id=row["id"],
            run_type=row["run_type"],
            params=dict(row["params"] or {}),
            attempts=row["attempts"] + 1,
            max_attempts=row["max_attempts"],
        )
