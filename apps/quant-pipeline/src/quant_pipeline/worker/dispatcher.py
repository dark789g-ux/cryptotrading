"""Dispatcher：把 Job 路由到对应 runner。

_ROUTES 覆盖全部 run_type（noop / sync / factors / quality / labels /
features / train / infer / optuna / seed_avg / monitor）。未知 run_type
直接置 failed 终态。
"""

from __future__ import annotations

import logging
import threading
import traceback
from typing import Any
from uuid import UUID

from sqlalchemy import text

from quant_pipeline.config.settings import get_settings
from quant_pipeline.db.engine import session_scope
from quant_pipeline.worker.poller import Job
from quant_pipeline.worker.progress import (
    JobCancelled,
    check_cancel_requested,
    heartbeat,
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


def _runner_factors(job: Job) -> None:
    """factors runner 入口（M1 Part D）。

    路由到 quant_pipeline.factors.runner.runner_entrypoint；
    后者从 job.params 解析 version / date_range / factor_ids 并计算 + upsert。
    """

    # 延迟 import 避免 worker 模块在 factors 子树未就绪时 import 失败
    from quant_pipeline.factors.runner import runner_entrypoint

    runner_entrypoint(job)


def _runner_sync(job: Job) -> None:
    """sync runner（M1 Part C）：调用 quant_pipeline.sync.orchestrator.run_sync。

    params schema（01-pg-schema.md §4.1）：
      {
        "date_range": "YYYYMMDD:YYYYMMDD",
        "tables": ["trade_cal", ...],                   # 可选，默认全部 6 张
        "fina_indicator_ts_codes": ["600000.SH", ...]   # 可选，控制财务表覆盖范围
      }

    任一表 fetcher 0 行 / 三种空数据情形都已在 tushare_client 内部 warn 双写
    （日志 + ml.quality_reports，rule=`<api_name>_empty`），同时由 orchestrator
    push 到 outcome.failed_items（apiName 标 `<table>_empty`，对齐 CLAUDE.md
    "fetcher 0 行必须显式 failedItems" 规则）。dispatcher 此处只把概要写日志，
    job 整体仍判 success，真正阻断由 quality 门禁负责（spec §2）。
    """

    # 延迟 import：避免 noop / 其它 run_type 加载时拖入 pandas / tushare
    from quant_pipeline.sync.orchestrator import DEFAULT_TABLES, run_sync

    params = job.params or {}
    date_range = params.get("date_range")
    if not isinstance(date_range, str) or ":" not in date_range:
        raise ValueError(
            f"sync job params.date_range 必须是 'YYYYMMDD:YYYYMMDD'，got {date_range!r}"
        )

    tables_raw = params.get("tables") or list(DEFAULT_TABLES)
    if not isinstance(tables_raw, list) or not all(isinstance(t, str) for t in tables_raw):
        raise ValueError(
            f"sync job params.tables 必须是字符串数组，got {tables_raw!r}"
        )
    tables: tuple[str, ...] = tuple(tables_raw)

    ts_codes_raw = params.get("fina_indicator_ts_codes")
    if ts_codes_raw is not None:
        if not isinstance(ts_codes_raw, list) or not all(
            isinstance(t, str) for t in ts_codes_raw
        ):
            raise ValueError(
                "sync job params.fina_indicator_ts_codes 必须是字符串数组（可选）"
            )
        fina_ts_codes: tuple[str, ...] | None = tuple(ts_codes_raw)
    else:
        fina_ts_codes = None

    outcome = run_sync(
        job_id=job.id,
        date_range=date_range,
        tables=tables,
        fina_indicator_ts_codes=fina_ts_codes,
    )

    if outcome.failed_items or outcome.errors:
        logger.warning(
            "sync_job_completed_with_issues",
            extra={
                "job_id": str(job.id),
                "rows_total": outcome.rows_total,
                "per_table_rows": outcome.per_table_rows,
                "failed_items_count": len(outcome.failed_items),
                "errors_count": len(outcome.errors),
            },
        )


def _runner_labels(job: Job) -> None:
    """labels runner（M2 Part F）：调用 labels.runner.runner_entrypoint。

    params schema（01-pg-schema §4.1）：
      {"scheme": "strategy-aware", "date_range": "YYYYMMDD:YYYYMMDD"}
    """

    from quant_pipeline.labels.runner import runner_entrypoint

    runner_entrypoint(job)


def _runner_features(job: Job) -> None:
    """features runner（M2 Part F）：调用 features.runner.runner_entrypoint。

    params schema（01-pg-schema §4.1）：
      {"factor_version": "v1", "label_scheme": "strategy-aware",
       "date_range": "YYYYMMDD:YYYYMMDD"}
    """

    from quant_pipeline.features.runner import runner_entrypoint

    runner_entrypoint(job)


def _runner_quality(job: Job) -> None:
    """quality runner 入口（M1 Part E）。

    params 约定（01-pg-schema §4.1）：
        date:   YYYYMMDD（必填）
        strict: bool（默认 false；true 时 critical 抛 QualityGateBlocked）

    阈值参数（row_count_drift_threshold / adj_jump_ratio_threshold 等）
    透传给 run_checks。QualityGateBlocked 由 dispatch() 捕获后置 blocked。
    """

    from quant_pipeline.quality.runner import run_checks

    params = job.params or {}
    trade_date = params.get("date")
    if (
        not isinstance(trade_date, str)
        or len(trade_date) != 8
        or not trade_date.isdigit()
    ):
        raise ValueError(
            f"quality job.params.date must be YYYYMMDD string, got {trade_date!r}"
        )
    strict = bool(params.get("strict", False))

    update_progress(job.id, 0, stage="quality_start")
    if check_cancel_requested(job.id):
        raise JobCancelled

    check_params: dict[str, Any] = {}
    for key in (
        "row_count_drift_threshold",
        "adj_jump_ratio_threshold",
        "extreme_sigma",
        "null_violation_columns",
        "pk_map",
        "factor_version",
        "fundamental_factor_prefix",
    ):
        if key in params:
            check_params[key] = params[key]

    run_checks(trade_date, strict=strict, params=check_params, job_id=job.id)
    update_progress(job.id, 100, stage="quality_done")


def _runner_train(job: Job) -> None:
    """train runner 入口（M2 Part G）。

    路由到 quant_pipeline.training.runner.runner_entrypoint；
    内部按 0→25→50→75→100 写进度，遇 QualityGateBlocked 由 dispatch() 接住置 blocked。

    params schema（01-pg-schema §4.1）：
      {
        "feature_set_id": "fs_v1",
        "model": "lgb-lambdarank",          # optional, default lgb-lambdarank
        "walk_forward": false,              # optional, default false
        "seed": 42                          # optional, default 42
      }
    """

    from quant_pipeline.training.runner import runner_entrypoint as _train_entry

    _train_entry(job)


def _runner_infer(job: Job) -> None:
    """infer runner 入口（M2 Part G）。

    路由到 quant_pipeline.inference.runner.runner_entrypoint；推理前必检失败抛
    QualityGateBlocked，不会写入任何 ml.scores_daily 行。

    params schema（01-pg-schema §4.1）：
      {
        "model_version": "lgb-lambdarank-v1-20260620-seed42",
        "date":          "20260517"
      }
    """

    from quant_pipeline.inference.runner import runner_entrypoint as _infer_entry

    _infer_entry(job)


def _runner_optuna(job: Job) -> None:
    """optuna runner（M4 Part L）：调 training.tuning.runner_entrypoint。

    params schema（01-pg-schema §4.1）：
      {"feature_set_id": "fs_v1", "n_trials": 50, "space": "default"}
    """

    from quant_pipeline.training.tuning import runner_entrypoint as _entry

    _entry(job)


def _runner_seed_avg(job: Job) -> None:
    """seed_avg runner（M4 Part L）：调 training.seed_averaging.runner_entrypoint。

    params schema：
      {"feature_set_id": "fs_v1", "seeds": [42,123,456,789,1024]}
    """

    from quant_pipeline.training.seed_averaging import runner_entrypoint as _entry

    _entry(job)


def _runner_monitor(job: Job) -> None:
    """monitor runner（M4 Part L）：调 quality.monitor.runner_entrypoint。

    params schema：
      {"date": "YYYYMMDD", "model_version": "..."}
    """

    from quant_pipeline.quality.monitor import runner_entrypoint as _entry

    _entry(job)


# run_type → runner 路由表
_ROUTES = {
    "noop": _runner_noop,
    # M1
    "sync": _runner_sync,
    "factors": _runner_factors,
    "quality": _runner_quality,
    # M2 Part F
    "labels": _runner_labels,
    "features": _runner_features,
    # M2 Part G
    "train": _runner_train,
    "infer": _runner_infer,
    # M4 Part L
    "optuna": _runner_optuna,
    "seed_avg": _runner_seed_avg,
    "monitor": _runner_monitor,
}


# ----------------------------------------------------------------------
# Job 终态写入助手
# ----------------------------------------------------------------------

# ── attempts 自增语义（问题 2，写死，勿改）─────────────────────────────
# 单一来源：**poll 统一自增 attempts**（poller.py 的 `attempts = attempts + 1`
# 对任何 pending→running 转换生效，含首次领取）。
# 因此凡是把 job 置回 'pending' 的代码路径——reaper 回收、_finalize_job 失败
# 重试——一律 **不得** 改动 attempts，交由下一次 poll 自增。
# 重试预算判断 `attempts < max_attempts` 读的是「本次运行所用的 attempts
# 值」（poll 领取时已自增过），成立即表示还有下一次运行的预算。
# ──────────────────────────────────────────────────────────────────────


def _finalize_job(
    job_id: UUID,
    *,
    status: str,
    progress: int = 100,
    error_text: str | None = None,
    blocked_reason: str | None = None,
) -> None:
    """写 job 终态（success / failed / cancelled / blocked）。

    终态写入时一并清 cancel_requested（问题 3）：否则被取消的 job 若后续
    重新进入 pending（手工改、或失败重试），check_cancel_requested 会立刻
    返回 True 让 runner 一启动就被取消，无法摆脱。
    """

    with session_scope() as session:
        session.execute(
            text(
                """
                UPDATE ml.jobs
                SET status           = :status,
                    progress         = :progress,
                    error_text       = :error_text,
                    blocked_reason   = :blocked_reason,
                    cancel_requested = false,
                    finished_at      = now(),
                    heartbeat_at     = now()
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


def _requeue_job(job_id: UUID, *, error_text: str | None = None) -> None:
    """把失败的 job 置回 pending 以便重试（问题 1）。

    清 started_at / heartbeat_at / finished_at / blocked_reason，保留
    error_text 记录上一次失败原因。**不动 attempts**（见上方语义注释，
    由下一次 poll 自增）。
    """

    with session_scope() as session:
        session.execute(
            text(
                """
                UPDATE ml.jobs
                SET status         = 'pending',
                    progress       = 0,
                    error_text     = :error_text,
                    blocked_reason = NULL,
                    started_at     = NULL,
                    heartbeat_at   = NULL,
                    finished_at    = NULL
                WHERE id = :job_id
                """
            ),
            {"error_text": error_text, "job_id": job_id},
        )


# ----------------------------------------------------------------------
# 后台 heartbeat 线程（问题 4）
# ----------------------------------------------------------------------

class _HeartbeatThread:
    """runner 执行期间周期刷新 heartbeat_at 的后台守护线程。

    问题 4：长任务（sync/train/optuna）若两次 update_progress 间隔 >
    reaper stale 阈值，reaper 会把仍在运行的 job 误判超时并重置 pending，
    导致同一 job 被并发跑两遍。本线程独立于 runner 进度回调，按
    worker_heartbeat_interval_seconds 周期刷 heartbeat_at，保证 running
    job 在真正存活时不被回收。

    - daemon 线程：worker 进程退出不被它阻塞。
    - heartbeat 失败仅 logger.warning，不影响 runner（DB 抖动不应误杀任务）。
    - 通过 threading.Event 精确等待，stop() 后线程立即退出。
    """

    def __init__(self, job_id: UUID, interval_seconds: float) -> None:
        self._job_id = job_id
        # 间隔下限 1s，避免配置成 0 时空转打满 DB
        self._interval = max(1.0, float(interval_seconds))
        self._stop = threading.Event()
        self._thread = threading.Thread(
            target=self._run,
            name=f"heartbeat-{job_id}",
            daemon=True,
        )

    def _run(self) -> None:
        # 先等一个间隔再刷：poll 领取时已写过一次 heartbeat_at
        while not self._stop.wait(self._interval):
            try:
                heartbeat(self._job_id)
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "heartbeat_failed",
                    extra={"job_id": str(self._job_id), "err": str(exc)},
                )

    def __enter__(self) -> "_HeartbeatThread":
        self._thread.start()
        return self

    def __exit__(self, *exc: object) -> None:
        self._stop.set()
        # 给线程一点时间收尾；daemon 线程即便没 join 上也不阻塞进程退出
        self._thread.join(timeout=self._interval + 1.0)


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

        # 延迟 import 避免循环依赖
        from quant_pipeline.quality.runner import QualityGateBlocked

        hb_interval = get_settings().worker_heartbeat_interval_seconds
        try:
            with _HeartbeatThread(job.id, hb_interval):
                runner(job)
        except JobCancelled:
            logger.info("job_cancelled", extra={"job_id": str(job.id)})
            _finalize_job(job.id, status="cancelled")
        except QualityGateBlocked as exc:
            logger.warning(
                "quality_gate_blocked",
                extra={"job_id": str(job.id), "rule": exc.rule},
            )
            _finalize_job(
                job.id,
                status="blocked",
                blocked_reason=exc.rule,
                error_text=f"quality gate blocked: {exc.rule}\n{exc.detail}",
            )
        except Exception as exc:  # noqa: BLE001 —— 任何未捕获异常须落 error_text（04 §1）
            tb = traceback.format_exc()
            # 问题 1：runner 主动失败也走重试预算，attempts < max_attempts
            # 时置回 pending（由下一次 poll 重新领取并自增 attempts），
            # 否则才置 failed 终态。
            if job.attempts < job.max_attempts:
                logger.warning(
                    "job_failed_will_retry",
                    extra={
                        "job_id": str(job.id),
                        "run_type": job.run_type,
                        "attempts": job.attempts,
                        "max_attempts": job.max_attempts,
                        "err": str(exc),
                    },
                )
                _requeue_job(job.id, error_text=tb)
            else:
                logger.error(
                    "job_failed",
                    extra={
                        "job_id": str(job.id),
                        "run_type": job.run_type,
                        "attempts": job.attempts,
                        "max_attempts": job.max_attempts,
                        "err": str(exc),
                    },
                )
                _finalize_job(job.id, status="failed", error_text=tb)
        else:
            _finalize_job(job.id, status="success", progress=100)


# ----------------------------------------------------------------------
# Reaper（02-quant-pipeline.md §4 + 00-index.md §3）
# ----------------------------------------------------------------------

def reap_stale_running_jobs(stale_minutes: float = 3) -> int:
    """回收 heartbeat 超时的 running 行；返回被回收的行数。

    规则：status='running' AND heartbeat_at < now() - interval '<stale> min'
      - attempts < max_attempts → 重置为 pending
      - 否则 → status='failed' + error_text='heartbeat_timeout'

    attempts 自增语义见 _finalize_job 上方注释：reaper 重置 pending 时
    **不动 attempts**，由下一次 poll 统一自增。`s.attempts < s.max_attempts`
    读的是本次运行所用的 attempts 值。
    """

    # 问题 6：interval 改用 make_interval + 绑定参数，与项目其它处一致。
    # make_interval(mins =>) 仅收整数，故以 secs（double precision）传入，
    # 支持浮点分钟。
    sql = text(
        """
        WITH stale AS (
            SELECT id, attempts, max_attempts
            FROM ml.jobs
            WHERE status = 'running'
              AND heartbeat_at < now() - make_interval(secs => :stale_secs)
            FOR UPDATE SKIP LOCKED
        ),
        retry AS (
            UPDATE ml.jobs j
            SET status       = 'pending',
                progress     = 0,
                heartbeat_at = NULL,
                started_at   = NULL,
                finished_at  = NULL
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
        row = session.execute(sql, {"stale_secs": float(stale_minutes) * 60.0}).first()
        count = int(row[0]) if row else 0
    if count:
        logger.warning("reaper_reaped", extra={"reaped": count})
    return count


# Convenience for unit tests: expose route table
def get_routes() -> dict[str, Any]:
    return dict(_ROUTES)
