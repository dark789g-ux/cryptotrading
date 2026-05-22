"""Progress / heartbeat / NOTIFY / warn 双写助手。

关键约定（01-pg-schema.md §4.2 + 00-index.md §3 通信契约）：
- update_progress 在同一事务内 UPDATE + NOTIFY
- NOTIFY payload 固定 schema：{"job_id":"<uuid>","progress":<int 0..100>,"stage":"<str>"}
- payload 总长 ≤ 1KB，禁止携带日志正文 / 堆栈 / 数组
- heartbeat 不发 NOTIFY，只刷 heartbeat_at
- warn_with_quality_report：日志 + ml.quality_reports 双写（04 §2 规范，M0 预留接口）
- ProgressCallback：CLI 终端进度条回调（M2 新增）
"""

from __future__ import annotations

import json
import logging
from typing import Any, Callable
from uuid import UUID

from sqlalchemy import text

from quant_pipeline.db.engine import session_scope

# CLI 进度回调类型：(progress: int, stage: str) -> None
ProgressCallback = Callable[[int, str], None]

logger = logging.getLogger(__name__)


class JobCancelled(Exception):
    """job 被请求取消时由 runner 抛出，dispatcher 捕获后写 status='cancelled'。"""


# NOTIFY 通道名（与 NestJS SSE bridge 约定一致）
_NOTIFY_CHANNEL = "ml_job_progress"

# payload 长度上限（远低于 PG 8KB 上限，匹配 00-index.md §3）
_PAYLOAD_MAX_BYTES = 1024


def _build_notify_payload(job_id: UUID, progress: int, stage: str | None) -> str:
    payload = {
        "job_id": str(job_id),
        "progress": int(progress),
        "stage": stage or "",
    }
    encoded = json.dumps(payload, ensure_ascii=False, separators=(",", ":"))
    if len(encoded.encode("utf-8")) > _PAYLOAD_MAX_BYTES:
        raise ValueError(
            f"NOTIFY payload exceeds {_PAYLOAD_MAX_BYTES} bytes (got {len(encoded)})"
        )
    return encoded


def update_progress(job_id: UUID, progress: int, stage: str | None = None) -> None:
    """同事务内 UPDATE ml.jobs + NOTIFY ml_job_progress。"""

    if not 0 <= progress <= 100:
        raise ValueError(f"progress must be in [0, 100], got {progress}")

    payload = _build_notify_payload(job_id, progress, stage)

    with session_scope() as session:
        session.execute(
            text(
                """
                UPDATE ml.jobs
                SET progress      = :progress,
                    stage         = :stage,
                    heartbeat_at  = now()
                WHERE id = :job_id
                """
            ),
            {"progress": progress, "stage": stage, "job_id": job_id},
        )
        # NOTIFY 只接受字面量字符串通道名 + 字符串 payload；用 pg_notify 函数形式参数化
        session.execute(
            text("SELECT pg_notify(:channel, :payload)"),
            {"channel": _NOTIFY_CHANNEL, "payload": payload},
        )


def heartbeat(job_id: UUID) -> None:
    """仅刷 heartbeat_at，不发 NOTIFY（02-quant-pipeline.md §4）。"""

    with session_scope() as session:
        session.execute(
            text("UPDATE ml.jobs SET heartbeat_at = now() WHERE id = :job_id"),
            {"job_id": job_id},
        )


def check_cancel_requested(job_id: UUID) -> bool:
    """供 runner 在每个工作单元开始前检查；true 时调用方应抛 JobCancelled。"""

    with session_scope() as session:
        row = session.execute(
            text("SELECT cancel_requested FROM ml.jobs WHERE id = :job_id"),
            {"job_id": job_id},
        ).first()
        return bool(row and row[0])


def warn_with_quality_report(
    *,
    rule: str,
    trade_date: str,
    detail: dict[str, Any],
    level: str = "warn",
    job_id: UUID | None = None,
) -> None:
    """warn 双写（04-error-quality-testing.md §2）：

    1) 结构化 JSON 日志（含 job_id 上下文）
    2) INSERT INTO ml.quality_reports (rule + detail)

    M0 阶段未触发 TuShare，但 dispatcher / sync 等模块需要的接口先在此预留，
    M1 起 tushare_client.py 三条空数据路径必须调用本函数。

    参数：
      rule:        见 01-pg-schema.md §4.3 规则名清单
      trade_date:  YYYYMMDD（A 股规范）
      detail:      jsonb，规则相关字段（api_name / params / empty_path 等）
      level:       info | warn | critical
      job_id:      用于日志上下文（可选）
    """

    if level not in ("info", "warn", "critical"):
        raise ValueError(f"level must be info|warn|critical, got {level}")
    if len(trade_date) != 8 or not trade_date.isdigit():
        raise ValueError(f"trade_date must be YYYYMMDD, got {trade_date!r}")

    # 1) 结构化日志
    logger.warning(
        "quality_report",
        extra={"rule": rule, "trade_date": trade_date, "detail": detail, "job_id": str(job_id) if job_id else None},
    )

    # 2) DB 写
    with session_scope() as session:
        session.execute(
            text(
                """
                INSERT INTO ml.quality_reports (trade_date, level, rule, detail)
                VALUES (:trade_date, :level, :rule, CAST(:detail AS jsonb))
                """
            ),
            {
                "trade_date": trade_date,
                "level": level,
                "rule": rule,
                "detail": json.dumps(detail, ensure_ascii=False),
            },
        )
