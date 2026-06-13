"""Dispatcher：把 Job 路由到对应 runner。

_ROUTES 覆盖全部 run_type（noop / sync / factors / quality / labels /
features / train / infer / optuna / seed_avg / monitor）。未知 run_type
直接置 failed 终态。
"""

from __future__ import annotations

import json
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
from quant_pipeline.worker.prepare_runner import StepError, run_prepare

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


def _runner_kelly_sweep(job: Job) -> None:
    """kelly_sweep runner（spec 2026-06-09）：凯利上界网格扫描研究 harness。

    复刻 CLI 的 _run_sweep_pipeline 调用链：
      enumerate_signals → load_forward_paths → load_feature_inputs →
      load_index_daily → run_sweep → compute_pareto_frontier →
      rank_top_k → persist_results

    params schema（spec 02 data-model）：
      {
        "base_trigger": {"field": "kdj_j", "op": "lt", "value": 0.0},
        "universe": "all",
        "max_window": 20, "max_entry_filters": 1, "min_samples": 300,
        "train_range": ["20230101", "20241231"],
        "valid_range": ["20250101", "20260608"],
        "bootstrap_iters": 1000, "same_day_rule": "sl_first",
        "rs_benchmark": ["hs300", "zz500"], "rs_lookback": 5, "top_k": 30,
        "exit_families": ["fixed_n", "tp_sl", "trailing", "atr_stop"]
      }

    结果写入 research.kelly_sweep_results；摘要写入 ml.jobs.result_payload。
    """

    from quant_pipeline.worker.kelly_sweep_runner import run_kelly_sweep

    result = run_kelly_sweep(job)
    _update_job_result(job.id, result)


def _make_progress_callback(job_id: UUID) -> Any:
    """构造一个把进度回写 ml.jobs 的 callback，供 prepare_runner 使用。

    prepare_runner 自己不直接调 `update_progress`：让父 callback 承担写库，
    子 runner 透过 `make_scaled_callback` 缩放后再触达父 callback。
    """

    def _cb(progress: int, stage: str) -> None:
        update_progress(job_id, progress, stage=stage)

    return _cb


def _runner_prepare(job: Job) -> None:
    """prepare runner（spec 2026-06-06 §03）：单 job 顺序跑 labels → features（备料）。

    不含训练步骤（train 由独立 run_type='train' job 负责）。
    force_recompute 从 params 读取（默认 False=增量缺口算法）。

    - StepError：写 `[step:<name>] <traceback>` 到 error_text 后 raise。
    - JobCancelled：直抛，outer dispatcher 写 status='cancelled'。
    - 其他 Exception（含 `_validate_params` 抛的 ValueError）：标 `[step:validate]`。

    成功时写 `ml.jobs.result_payload`（feature_set_id + last_completed_step）。
    """

    progress_cb = _make_progress_callback(job.id)
    try:
        result = run_prepare(job.id, job.params or {}, progress_cb)
    except StepError as se:
        full_tb = "".join(
            traceback.format_exception(
                type(se.original), se.original, se.original.__traceback__
            )
        )
        _update_job_error(job.id, f"[step:{se.step}] {full_tb}")
        raise
    except JobCancelled:
        raise
    except Exception:  # noqa: BLE001 —— validate 阶段任意异常都进 [step:validate]
        _update_job_error(
            job.id, f"[step:validate] {traceback.format_exc()}"
        )
        raise

    _update_job_result(job.id, result)


def _update_job_result(job_id: UUID, result: dict[str, Any]) -> None:
    """把 prepare/train_e2e 的返回 dict 写到 ml.jobs.result_payload（D-13）。

    仅在成功时调用；失败时保持 result_payload 为 NULL / 空，让上游 SSE
    bridge 不展示半成品。
    """

    payload = json.dumps(result, ensure_ascii=False)
    with session_scope() as session:
        session.execute(
            text(
                """
                UPDATE ml.jobs
                SET result_payload = CAST(:rp AS jsonb)
                WHERE id = :id
                """
            ),
            {"id": job_id, "rp": payload},
        )


def _update_job_error(job_id: UUID, error_text: str) -> None:
    """单独写 error_text（不触发终态、不发 NOTIFY）。

    `_finalize_job` 在终态写入时也会写 error_text；这里先于 raise 写一次，
    保证哪怕 outer dispatcher 因为某些边界路径漏写，也至少有 step-prefixed
    错误留底。outer dispatcher 后续的 `_finalize_job` 会用完整 traceback
    覆盖本字段（覆盖 tb 仍包含 StepError.__str__ 的 `[step:<name>]` 前缀）。
    """

    with session_scope() as session:
        session.execute(
            text("UPDATE ml.jobs SET error_text = :e WHERE id = :id"),
            {"e": error_text, "id": job_id},
        )


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
    # spec 2026-06-06 prepare（labels→features 增量串联备料；废弃 train_e2e）
    "prepare": _runner_prepare,
    # M2 Part G
    "train": _runner_train,
    "infer": _runner_infer,
    # M4 Part L
    "optuna": _runner_optuna,
    "seed_avg": _runner_seed_avg,
    "monitor": _runner_monitor,
    # spec 2026-06-09 kelly_sweep
    "kelly_sweep": _runner_kelly_sweep,
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

    def __enter__(self) -> _HeartbeatThread:
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

# 孤儿 running job 回收的 error_text 标记（决策 3）：worker 崩溃/被杀后卡 running
# 的行，heartbeat_at 早于阈值 → reaper 回收。无论重 pending 还是置 failed，都把
# error_text 标成本前缀，便于事后区分「孤儿回收」与「runner 主动失败」（后者由
# dispatcher 写完整 traceback）。
_ORPHAN_ERROR_TEXT = "orphaned: stale heartbeat (worker likely crashed/killed)"


def reap_stale_running_jobs(stale_seconds: float = 600.0) -> int:
    """回收 heartbeat 超时的孤儿 running 行；返回被回收的行数。

    判据（决策 2）：status='running' AND heartbeat_at < now() - <stale_seconds> 秒。
    阈值由调用方（worker/loop.py）从 settings.worker_stale_running_threshold_seconds
    透传，默认 600s（10 分钟），远大于心跳周期（默认 30s），**绝不误杀活 job**：
    存活的 running job 由 _HeartbeatThread 每 ~30s 刷新 heartbeat_at，永远不会落到
    now() - 10min 之前。

    处置（决策 3，与 dispatcher 正常失败路径 dispatcher.dispatch 同款重试语义）：
      - attempts < max_attempts → 重置为 pending（由下一次 poll 重新领取并自增
        attempts）。kelly_sweep / labels 重跑均幂等，故重试安全：
          · kelly_sweep：persist_results 写前 DELETE WHERE job_id=? 再 INSERT
            （persist.py），半成品被本 job 重跑覆盖、无残留；
          · labels：增量缺口检测 + INSERT ... ON CONFLICT DO UPDATE 行级 upsert
            （labels/runner.py），重跑只补缺口 / 覆盖同 PK，幂等。
        error_text 标 _ORPHAN_ERROR_TEXT，供事后追溯本次孤儿回收。
      - 否则（attempts 已耗尽）→ status='failed' + error_text=_ORPHAN_ERROR_TEXT
        + finished_at=now()（终态，不再重试）。

    attempts 自增语义见 _finalize_job 上方注释：reaper 重置 pending 时
    **不动 attempts**，由下一次 poll 统一自增。`s.attempts < s.max_attempts`
    读的是本次运行所用的 attempts 值。

    并发安全（决策 4）：stale CTE 用 FOR UPDATE SKIP LOCKED 取行（与 poll_one 同款），
    多 worker 同时 reaper 时各取互斥子集、不重复回收。

    Args:
        stale_seconds: 孤儿判定阈值（秒）。默认 600（与 settings 默认对齐）。
    """

    # interval 用 make_interval(secs => ...) + 绑定参数（与项目其它处一致）；
    # 时间列 timestamptz、比对 now()（项目 datetime 规范）。
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
                error_text   = :orphan_text,
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
                error_text  = :orphan_text,
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
        row = session.execute(
            sql,
            {"stale_secs": float(stale_seconds), "orphan_text": _ORPHAN_ERROR_TEXT},
        ).first()
        count = int(row[0]) if row else 0
    if count:
        logger.warning("reaper_reaped", extra={"reaped": count, "stale_seconds": stale_seconds})
    return count


# Convenience for unit tests: expose route table
def get_routes() -> dict[str, Any]:
    return dict(_ROUTES)
