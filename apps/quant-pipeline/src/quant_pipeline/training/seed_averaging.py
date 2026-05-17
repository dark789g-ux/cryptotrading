"""Seed Averaging（M4 Part L）。

> 方法论：doc/量化/05-LightGBM训练体系.md §5.7 Seed Averaging：
>   - 5 个 seed 各跑一次完整训练
>   - 推理时把各 seed 的 booster 预测分数取截面 z-score + 等权平均
>
> 落库规则：
>   - 5 个 seed 各自一条 ml.model_runs（model_version = `lgb-lambdarank-v1-<YYYYMMDD>-seed<seed>`）
>     并各自一条 ml.jobs（child job，parent_job_id 指向调度它们的父 job）
>   - 父 job 完成后另外写一条 ml.model_runs：
>     model_version = `lgb-lambdarank-v1-<YYYYMMDD>-seedavg5`
>     artifact_uri = './artifacts/<父 run_id>/seed_avg_meta.json'
>     hyperparams = {"seeds": [...], "child_run_ids": [...]}
>     oos_metrics = 各子 run 的 OOS NDCG@10 / IC 等加权平均
>
> 进度回写：每完成一个 seed 调 worker.progress.update_progress。
"""

from __future__ import annotations

import json
import logging
import shutil
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.utils.paths import artifact_dir, artifact_uri, ensure_artifact_dir
from quant_pipeline.worker.progress import update_progress

logger = logging.getLogger(__name__)


DEFAULT_SEEDS: tuple[int, ...] = (42, 123, 456, 789, 1024)


# ----------------------------------------------------------------------
# child job 注册（M4 - parent_job_id 关联）
# ----------------------------------------------------------------------


def _create_child_train_job(
    *,
    feature_set_id: str,
    seed: int,
    parent_job_id: UUID,
) -> UUID:
    """为每个 seed 写一条 ml.jobs (run_type='train', parent_job_id=父)，并立即 success。

    spec 约束：parent_job_id 指向父；status='success' 直接置位，因为
    seed_avg 调度器内部就把 5 次训练串行跑完，每个子 job 不走 worker 路径。
    """

    child_id = uuid4()
    params = {
        "feature_set_id": feature_set_id,
        "model": "lgb-lambdarank",
        "walk_forward": True,
        "seed": seed,
        "parent_job_id": str(parent_job_id),
    }
    sql = text(
        """
        INSERT INTO ml.jobs
            (id, run_type, params, status, progress, stage, parent_job_id,
             priority, created_by, started_at, finished_at, heartbeat_at)
        VALUES
            (:id, 'train', CAST(:params AS jsonb), 'running', 0, 'seed_start',
             :parent, 90, 'seed_avg', now(), NULL, now())
        """
    )
    with session_scope() as session:
        session.execute(
            sql,
            {
                "id": child_id,
                "params": json.dumps(params, ensure_ascii=False),
                "parent": parent_job_id,
            },
        )
    return child_id


def _finalize_child_job(
    child_id: UUID,
    *,
    status: str,
    progress: int = 100,
    error_text: str | None = None,
) -> None:
    sql = text(
        """
        UPDATE ml.jobs
        SET status      = :status,
            progress    = :progress,
            error_text  = :err,
            finished_at = now(),
            heartbeat_at = now()
        WHERE id = :id
        """
    )
    with session_scope() as session:
        session.execute(
            sql,
            {
                "status": status,
                "progress": progress,
                "err": error_text,
                "id": child_id,
            },
        )


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------


def train_seed_average(
    feature_set_id: str,
    seeds: list[int] | tuple[int, ...] = DEFAULT_SEEDS,
    *,
    parent_job_id: UUID | None = None,
    walk_forward: bool = True,
    train_fn: Any = None,
    today_yyyymmdd: str | None = None,
) -> dict[str, Any]:
    """5 个 seed 各跑一次训练 → 父 model_run 聚合。

    Args:
        feature_set_id: 因子集
        seeds: 默认 [42, 123, 456, 789, 1024]
        parent_job_id: 调度它的父 ml.jobs.id；若提供则每个子 seed 跑前注册一条 child ml.jobs
        walk_forward: 透传给 train_model
        train_fn: 测试期注入 mock；生产模式默认 quant_pipeline.training.runner.train_model
        today_yyyymmdd: 测试可注入；默认今天 UTC

    Returns:
        {
            "ensemble_model_run_id": str,
            "ensemble_model_version": str,
            "child_model_run_ids": [str, ...],
            "child_model_versions": [str, ...],
            "child_oos_metrics": [dict, ...],
            "ensemble_oos_metrics": dict,
        }
    """

    if not seeds:
        raise ValueError("seeds 不能为空")
    seeds = list(seeds)

    if train_fn is None:
        from quant_pipeline.training.runner import train_model as train_fn  # type: ignore[assignment]

    today = today_yyyymmdd or datetime.now(timezone.utc).strftime("%Y%m%d")
    ensemble_model_version = f"lgb-lambdarank-v1-{today}-seedavg5"

    child_run_ids: list[str] = []
    child_model_versions: list[str] = []
    child_metrics: list[dict[str, Any]] = []

    total = len(seeds)
    for i, seed in enumerate(seeds):
        child_job_id: UUID | None = None
        if parent_job_id is not None:
            try:
                child_job_id = _create_child_train_job(
                    feature_set_id=feature_set_id,
                    seed=seed,
                    parent_job_id=parent_job_id,
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "seed_avg_child_job_create_failed",
                    extra={"seed": seed, "err": str(exc)},
                )
                child_job_id = None

        try:
            result = train_fn(
                feature_set_id=feature_set_id,
                model="lgb-lambdarank",
                walk_forward=walk_forward,
                seed=seed,
                job_id=child_job_id,
            )
        except Exception as exc:
            if child_job_id is not None:
                _finalize_child_job(
                    child_job_id, status="failed", error_text=str(exc)
                )
            raise

        if child_job_id is not None:
            _finalize_child_job(child_job_id, status="success")

        child_run_ids.append(str(result.model_run_id))
        child_model_versions.append(result.model_version)
        child_metrics.append(dict(result.oos_metrics))

        if parent_job_id is not None:
            done = i + 1
            pct = min(95, int(done / total * 90))
            try:
                update_progress(
                    parent_job_id,
                    pct,
                    stage=f"seed_avg:{done}/{total}_seed{seed}",
                )
            except Exception as exc:  # noqa: BLE001
                logger.warning(
                    "seed_avg_progress_update_failed",
                    extra={"seed": seed, "err": str(exc)},
                )

    # 聚合 OOS metrics：对每个 key 求平均（缺失的 key 跳过）
    ensemble_metrics = _average_metrics(child_metrics)

    # 落父 model_run + artifact metadata
    ensemble_run_id, ensemble_uri = _write_ensemble_model_run(
        feature_set_id=feature_set_id,
        ensemble_model_version=ensemble_model_version,
        seeds=seeds,
        child_run_ids=child_run_ids,
        child_model_versions=child_model_versions,
        child_metrics=child_metrics,
        ensemble_metrics=ensemble_metrics,
        parent_job_id=parent_job_id,
    )

    if parent_job_id is not None:
        update_progress(parent_job_id, 100, stage="seed_avg:done")

    logger.info(
        "seed_average_done",
        extra={
            "ensemble_model_run_id": str(ensemble_run_id),
            "ensemble_model_version": ensemble_model_version,
            "n_seeds": len(seeds),
        },
    )

    return {
        "ensemble_model_run_id": str(ensemble_run_id),
        "ensemble_model_version": ensemble_model_version,
        "ensemble_artifact_uri": ensemble_uri,
        "child_model_run_ids": child_run_ids,
        "child_model_versions": child_model_versions,
        "child_oos_metrics": child_metrics,
        "ensemble_oos_metrics": ensemble_metrics,
        "seeds": list(seeds),
    }


def _average_metrics(metrics_list: list[dict[str, Any]]) -> dict[str, Any]:
    """对每个数值 key 求平均；非数值 key 取第一个。"""

    if not metrics_list:
        return {}
    keys: set[str] = set()
    for m in metrics_list:
        keys.update(m.keys())
    agg: dict[str, Any] = {}
    for k in sorted(keys):
        # 排除 bool（Python 中 bool 是 int 子类，不能参与数值平均）
        vals = [
            m.get(k)
            for m in metrics_list
            if isinstance(m.get(k), (int, float))
            and not isinstance(m.get(k), bool)
        ]
        if vals:
            agg[k] = sum(vals) / len(vals)
        else:
            # 非数值：取第一个有值的
            for m in metrics_list:
                if k in m and m[k] is not None:
                    agg[k] = m[k]
                    break
    agg["n_seeds"] = len(metrics_list)
    return agg


def _write_ensemble_model_run(
    *,
    feature_set_id: str,
    ensemble_model_version: str,
    seeds: list[int],
    child_run_ids: list[str],
    child_model_versions: list[str],
    child_metrics: list[dict[str, Any]],
    ensemble_metrics: dict[str, Any],
    parent_job_id: UUID | None,
) -> tuple[UUID, str]:
    """写父 model_run + 一份 metadata 文件 seed_avg_meta.json。

    artifact_uri 指向 metadata（不是真的 model.txt），推理时按 child run artifact 平均。
    """

    run_id = uuid4()
    target = ensure_artifact_dir(run_id)
    meta_path = target / "seed_avg_meta.json"

    seed_avg_meta = {
        "model_run_id": str(run_id),
        "model_version": ensemble_model_version,
        "feature_set_id": feature_set_id,
        "seeds": list(seeds),
        "child_run_ids": child_run_ids,
        "child_model_versions": child_model_versions,
        "child_oos_metrics": child_metrics,
        "ensemble_oos_metrics": ensemble_metrics,
        "created_at_utc": datetime.now(timezone.utc).isoformat(),
        "note": (
            "inference 时按 child_run_ids 各自 booster 横截面 z-score + 等权平均；"
            "本 artifact 仅为 metadata，不是 model.txt"
        ),
    }

    try:
        with meta_path.open("w", encoding="utf-8") as f:
            json.dump(seed_avg_meta, f, ensure_ascii=False, indent=2)
    except OSError as exc:
        shutil.rmtree(target, ignore_errors=True)
        raise RuntimeError(f"写 seed_avg_meta.json 失败: {exc}") from exc

    artifact_uri_str = artifact_uri(run_id, "seed_avg_meta.json")

    sql = text(
        """
        INSERT INTO ml.model_runs
            (id, job_id, model_version, feature_set_id, hyperparams,
             oos_metrics, artifact_uri, report_uri)
        VALUES
            (:id, :job_id, :mv, :fs, CAST(:hp AS jsonb), CAST(:oos AS jsonb),
             :uri, NULL)
        """
    )
    hp = {
        "seeds": list(seeds),
        "child_run_ids": child_run_ids,
        "child_model_versions": child_model_versions,
        "strategy": "seed_averaging",
    }
    try:
        with session_scope() as session:
            session.execute(
                sql,
                {
                    "id": run_id,
                    "job_id": parent_job_id,
                    "mv": ensemble_model_version,
                    "fs": feature_set_id,
                    "hp": json.dumps(hp, ensure_ascii=False),
                    "oos": json.dumps(ensemble_metrics, ensure_ascii=False),
                    "uri": artifact_uri_str,
                },
            )
    except Exception:
        try:
            shutil.rmtree(artifact_dir(run_id), ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        raise

    return run_id, artifact_uri_str


# ----------------------------------------------------------------------
# Dispatcher 入口
# ----------------------------------------------------------------------


def runner_entrypoint(job: Any) -> None:
    """worker.dispatcher 路由：run_type='seed_avg'。

    params schema（01-pg-schema §4.1）：
        {
            "feature_set_id": "fs_v1",
            "seeds": [42, 123, 456, 789, 1024]   # 可选，默认 5 个
        }
    """

    params = getattr(job, "params", {}) or {}
    feature_set_id = params.get("feature_set_id")
    if not isinstance(feature_set_id, str) or not feature_set_id:
        raise ValueError(
            f"seed_avg job.params.feature_set_id 必须是非空字符串，got {feature_set_id!r}"
        )
    seeds_raw = params.get("seeds")
    if seeds_raw is None:
        seeds_list: list[int] = list(DEFAULT_SEEDS)
    else:
        if (
            not isinstance(seeds_raw, list)
            or not all(isinstance(s, int) for s in seeds_raw)
            or not seeds_raw
        ):
            raise ValueError(
                f"seed_avg job.params.seeds 必须是非空 int 列表，got {seeds_raw!r}"
            )
        seeds_list = list(seeds_raw)

    train_seed_average(
        feature_set_id=feature_set_id,
        seeds=seeds_list,
        parent_job_id=getattr(job, "id", None),
    )


__all__ = [
    "DEFAULT_SEEDS",
    "train_seed_average",
    "runner_entrypoint",
]
