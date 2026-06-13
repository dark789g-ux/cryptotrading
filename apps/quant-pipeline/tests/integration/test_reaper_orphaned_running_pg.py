"""孤儿 running job 回收（reaper）PG 集成测。

覆盖 prompts/add-orphaned-running-job-reclaim.md 的两关键场景：
  (a) heartbeat 已过期的 running job → 被 reaper 回收（重 pending 或 failed）；
  (b) heartbeat 新鲜的活 running job → reaper 跑时**不被**误回收。

测法（与 tests/integration 其它 PG 集成测同款）：
  - 往 ml.jobs 插入受控测试行并 commit（reaper 用独立 session_scope，看不见未提交行）；
  - 调 reap_stale_running_jobs(阈值秒)；
  - 只对**本测试插入的 job id** 断言（reaper 会扫全表，断言绝不触碰生产行）；
  - try/finally 用 id 精确清理，不留测试残留。

不启动 worker 进程、不跑任何 runner——纯粹验证 reaper SQL 的回收语义，秒级完成。
"""

from __future__ import annotations

from collections.abc import Iterator

import pytest
from sqlalchemy import text
from sqlalchemy.orm import Session

from quant_pipeline.worker.dispatcher import _ORPHAN_ERROR_TEXT, reap_stale_running_jobs

# 阈值取 600s（10 分钟）：与 settings 默认对齐。stale 行 heartbeat_at 设为
# now() - 1 小时（远超阈值）→ 应回收；fresh 行 heartbeat_at = now()（远新于阈值）
# → 不应回收。两者差异足够大，不受 DB 时钟微小漂移影响。
_THRESHOLD_SECONDS = 600.0


def _insert_running_job(
    session: Session,
    *,
    heartbeat_sql: str,
    attempts: int,
    max_attempts: int,
) -> str:
    """插入一行 status='running' 的测试 job，返回其 id（text）。

    heartbeat_sql 为一段 SQL 表达式（如 ``now()`` 或 ``now() - interval '1 hour'``），
    直接拼进 INSERT 的 heartbeat_at（受控字面量，无注入风险）。run_type 用 'noop'
    （始终在 run_type 白名单内）。started_at 同步写入，模拟真实领取过的 running 行。
    """

    row = session.execute(
        text(
            f"""
            INSERT INTO ml.jobs
                (run_type, status, attempts, max_attempts, heartbeat_at, started_at)
            VALUES
                ('noop', 'running', :attempts, :max_attempts, {heartbeat_sql}, now())
            RETURNING id
            """
        ),
        {"attempts": attempts, "max_attempts": max_attempts},
    ).first()
    assert row is not None
    return str(row[0])


def _status_of(session: Session, job_id: str) -> tuple[str, str | None, int | None]:
    """读回某 job 的 (status, error_text, progress)。"""

    row = session.execute(
        text("SELECT status, error_text, progress FROM ml.jobs WHERE id = :id"),
        {"id": job_id},
    ).first()
    assert row is not None, f"job {job_id} 不应在测试期间消失"
    return str(row[0]), (row[1] if row[1] is None else str(row[1])), int(row[2])


@pytest.fixture()
def _orphan_test_jobs(pg_session: Session) -> Iterator[dict[str, str]]:
    """插入 3 行受控测试 job 并 commit；测试结束按 id 精确清理。

    返回 {"stale_retry": id, "stale_giveup": id, "fresh": id}：
      - stale_retry:  过期 running，attempts(0) < max_attempts(1) → 应回收为 pending
      - stale_giveup: 过期 running，attempts(1) >= max_attempts(1) → 应回收为 failed
      - fresh:        新鲜 running（heartbeat=now），attempts(0)<max → 不应被回收
    """

    ids = {
        "stale_retry": _insert_running_job(
            pg_session,
            heartbeat_sql="now() - interval '1 hour'",
            attempts=0,
            max_attempts=1,
        ),
        "stale_giveup": _insert_running_job(
            pg_session,
            heartbeat_sql="now() - interval '1 hour'",
            attempts=1,
            max_attempts=1,
        ),
        "fresh": _insert_running_job(
            pg_session,
            heartbeat_sql="now()",
            attempts=0,
            max_attempts=1,
        ),
    }
    # reaper 用独立 session_scope（独立连接 + commit），看不见未提交行 → 必须先 commit。
    pg_session.commit()
    try:
        yield ids
    finally:
        # id 是 uuid 列；绑定的是 str → 用 id::text 比对避免 uuid=text 操作符缺失。
        pg_session.execute(
            text("DELETE FROM ml.jobs WHERE id::text = ANY(:ids)"),
            {"ids": list(ids.values())},
        )
        pg_session.commit()


def test_reaper_reclaims_stale_running_and_spares_fresh(
    pg_session: Session, _orphan_test_jobs: dict[str, str]
) -> None:
    """场景 (a)+(b) 一次跑全：过期 running 被回收、新鲜 running 不受影响。

    一次 reaper 调用同时验证三件事，避免多次扫表 / 多次触碰生产行：
      - stale_retry  → 'pending'（attempts < max_attempts），error_text 标孤儿
      - stale_giveup → 'failed'（attempts 耗尽），error_text 标孤儿
      - fresh        → 仍 'running'（heartbeat 新鲜，绝不误杀活 job）
    """

    reaped = reap_stale_running_jobs(_THRESHOLD_SECONDS)

    # reaper 扫全表：本测试至少回收了 2 行（stale_retry + stale_giveup）；
    # 可能 >2（若 DB 中另有真实孤儿），故用 >= 而非 ==，断言聚焦本测试自有行。
    assert reaped >= 2, f"应至少回收本测试的 2 行过期 running，实际 reaped={reaped}"

    # ── 场景 (a)-retry：过期 + 有重试预算 → pending，error_text 标孤儿，progress 归零 ──
    status, err, progress = _status_of(pg_session, _orphan_test_jobs["stale_retry"])
    assert status == "pending", f"过期且 attempts<max 的 running 应回收为 pending，得 {status}"
    assert err == _ORPHAN_ERROR_TEXT, f"重 pending 应标孤儿 error_text，得 {err!r}"
    assert progress == 0, f"重 pending 应把 progress 归零，得 {progress}"

    # ── 场景 (a)-giveup：过期 + 无重试预算 → failed，error_text 标孤儿 ──
    status, err, _ = _status_of(pg_session, _orphan_test_jobs["stale_giveup"])
    assert status == "failed", f"过期且 attempts>=max 的 running 应回收为 failed，得 {status}"
    assert err == _ORPHAN_ERROR_TEXT, f"failed 应标孤儿 error_text，得 {err!r}"

    # ── 场景 (b)：新鲜 running 绝不被误回收 ──
    status, err, _ = _status_of(pg_session, _orphan_test_jobs["fresh"])
    assert status == "running", f"heartbeat 新鲜的活 running job 不应被回收，得 {status}"
    assert err is None, f"未被回收的活 job 不应被写 error_text，得 {err!r}"


def test_reaper_with_huge_threshold_spares_even_stale(
    pg_session: Session, _orphan_test_jobs: dict[str, str]
) -> None:
    """阈值足够大时，连「1 小时前」的 running 也不回收——坐实阈值即「绝不误杀」的旋钮。

    用 2 天（172800s）阈值跑 reaper：本测试的过期行（仅 1 小时前）落在阈值内，
    三行都应保持 'running'，验证阈值越大越保守、不会误杀。
    """

    reap_stale_running_jobs(172800.0)  # 2 天

    for key in ("stale_retry", "stale_giveup", "fresh"):
        status, err, _ = _status_of(pg_session, _orphan_test_jobs[key])
        assert status == "running", (
            f"阈值 2 天时，1 小时前的 running({key}) 不应被回收，得 {status}"
        )
        assert err is None
