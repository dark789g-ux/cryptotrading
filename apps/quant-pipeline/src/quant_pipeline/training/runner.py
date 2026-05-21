"""training runner —— CLI / worker dispatcher 共用入口（M2 / M3）。

`train_model(feature_set_id, model='lgb-lambdarank', walk_forward=True, seed=42, job_id=None)`

M3 升级：
  - walk_forward=True（M3 默认开）：调用 PurgedWalkForwardSplit + ab_compare.compare_three
    跑三组对照 + 集成，按每折结束更新 progress；训练完自动生成 report.md
  - walk_forward=False：M2 单 fold 通路（保留，仅供冷启动 / 调试）

顺序：
  1) 训练前 quality 门禁（strict=True）
  2) 加载 feature_matrix → 排序 + 展平 + 过滤 NaN label
  3) [WF] PurgedWalkForwardSplit → compare_three（每折结束更新 progress）
     [single] SingleFoldSplit → train_lambdarank
  4) artifact 落盘：./artifacts/<run_id>/{model.txt, meta.json, report.md, daily_returns.csv}
  5) 写 ml.model_runs（含 oos_metrics + artifact_uri + report_uri）
  6) 任一失败回滚另一个

model_version 命名（硬约束）：`<algo>-v1-<YYYYMMDD>-seed<N>`

Walk-Forward + ensemble 逻辑已拆分到 walk_forward_runner.py。
"""

from __future__ import annotations

import json
import logging
import shutil
from dataclasses import dataclass
from datetime import datetime, timezone
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import pandas as pd
from sqlalchemy import text

from quant_pipeline.db.engine import session_scope
from quant_pipeline.quality.report import gate_check
from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_EARLY_STOPPING_ROUNDS,
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)
from quant_pipeline.training.walk_forward import SingleFoldSplit
from quant_pipeline.utils.paths import (
    artifact_dir,
    artifact_uri,
    ensure_artifact_dir,
)
from quant_pipeline.worker.progress import update_progress

logger = logging.getLogger(__name__)


class ArtifactWriteError(RuntimeError):
    """artifact 目录写不进去 / 文件落盘失败时由 runner 抛出。

    dispatcher 接住后清理半成品 + 把 job status='failed'。
    """


@dataclass(slots=True)
class TrainResult:
    """train_model 的最小返回结构。"""

    model_run_id: UUID
    model_version: str
    artifact_uri: str
    oos_metrics: dict[str, Any]
    report_uri: str | None = None


# ----------------------------------------------------------------------
# DB 访问
# ----------------------------------------------------------------------


def _load_feature_matrix(feature_set_id: str) -> pd.DataFrame:
    """从 factors.feature_matrix 拉某个 feature_set 的全量样本。"""

    sql = text(
        """
        SELECT trade_date, ts_code, features, label
        FROM factors.feature_matrix
        WHERE feature_set_id = :fs
        ORDER BY trade_date, ts_code
        """
    )
    with session_scope() as session:
        rows = session.execute(sql, {"fs": feature_set_id}).mappings().all()
    if not rows:
        raise ValueError(
            f"feature_matrix 中找不到 feature_set_id={feature_set_id!r} 的样本"
        )
    df = pd.DataFrame(
        [
            {
                "trade_date": r["trade_date"],
                "ts_code": r["ts_code"],
                "features": dict(r["features"]) if r["features"] else {},
                "label": float(r["label"]) if r["label"] is not None else np.nan,
            }
            for r in rows
        ]
    )
    return df


def _latest_trade_date_from_features(df: pd.DataFrame) -> str:
    if df.empty:
        raise ValueError("feature_matrix 为空，无法定位最近交易日")
    return str(df["trade_date"].astype(str).max())


def _build_groups(df: pd.DataFrame) -> np.ndarray:
    """以 trade_date 为 query group；返回每日样本数数组（顺序与 df 一致）。"""

    counts = df.groupby("trade_date", sort=False).size().to_numpy()
    return counts.astype(np.int64)


def _flatten_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """把 features:dict 列展平为多列。"""

    if df.empty:
        return pd.DataFrame(), []
    feature_keys: list[str] = sorted(
        {k for row in df["features"] if isinstance(row, dict) for k in row.keys()}
    )
    if not feature_keys:
        raise ValueError("feature_matrix.features 为空，没有可训练的列")
    records = [
        {k: row.get(k, np.nan) if isinstance(row, dict) else np.nan for k in feature_keys}
        for row in df["features"]
    ]
    X = pd.DataFrame.from_records(records, columns=feature_keys)
    return X, feature_keys


# ----------------------------------------------------------------------
# 评估（M2 单 fold 用）—— 保留兼容
# ----------------------------------------------------------------------


def _ndcg_at_k(scores: np.ndarray, labels: np.ndarray, groups: np.ndarray, k: int = 10) -> float:
    """旧入口：转调 evaluation.ranking_metrics.ndcg_at_k（保留旧名给单测）。"""

    from quant_pipeline.evaluation.ranking_metrics import ndcg_at_k

    return ndcg_at_k(scores, labels, groups, k=k)


def _pearson_ic(scores: np.ndarray, labels: np.ndarray) -> float:
    from quant_pipeline.evaluation.ranking_metrics import ic_pearson

    return ic_pearson(scores, labels)


def _spearman_rank_ic(scores: np.ndarray, labels: np.ndarray) -> float:
    from quant_pipeline.evaluation.ranking_metrics import rank_ic_spearman

    return rank_ic_spearman(scores, labels)


# ----------------------------------------------------------------------
# Artifact I/O
# ----------------------------------------------------------------------


def _write_artifact(
    run_id: UUID,
    booster: Any,
    meta: dict[str, Any],
) -> tuple[str, str]:
    """落盘 model.txt + meta.json；任一失败抛 ArtifactWriteError 并清理目录。"""

    try:
        target_dir = ensure_artifact_dir(run_id)
    except OSError as exc:
        raise ArtifactWriteError(f"无法创建 artifact 目录 {run_id}: {exc}") from exc

    model_path = target_dir / "model.txt"
    meta_path = target_dir / "meta.json"
    try:
        booster.save_model(str(model_path))
        with meta_path.open("w", encoding="utf-8") as f:
            json.dump(meta, f, ensure_ascii=False, indent=2)
    except Exception as exc:  # noqa: BLE001
        try:
            shutil.rmtree(target_dir, ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        raise ArtifactWriteError(f"artifact 写盘失败: {exc}") from exc

    return artifact_uri(run_id, "model.txt"), artifact_uri(run_id, "meta.json")


def _insert_model_run(
    run_id: UUID,
    *,
    job_id: UUID | None,
    model_version: str,
    feature_set_id: str,
    hyperparams: dict[str, Any],
    oos_metrics: dict[str, Any],
    artifact_uri_str: str,
    report_uri_str: str | None = None,
) -> None:
    """写 ml.model_runs；失败则由调用方清理 artifact 目录。"""

    sql = text(
        """
        INSERT INTO ml.model_runs
            (id, job_id, model_version, feature_set_id, hyperparams,
             oos_metrics, artifact_uri, report_uri)
        VALUES
            (:id, :job_id, :model_version, :feature_set_id,
             CAST(:hyperparams AS jsonb), CAST(:oos_metrics AS jsonb),
             :artifact_uri, :report_uri)
        """
    )
    with session_scope() as session:
        session.execute(
            sql,
            {
                "id": run_id,
                "job_id": job_id,
                "model_version": model_version,
                "feature_set_id": feature_set_id,
                "hyperparams": json.dumps(hyperparams, ensure_ascii=False),
                "oos_metrics": json.dumps(oos_metrics, ensure_ascii=False),
                "artifact_uri": artifact_uri_str,
                "report_uri": report_uri_str,
            },
        )


# ----------------------------------------------------------------------
# 主入口
# ----------------------------------------------------------------------


def train_model(
    feature_set_id: str,
    model: str = "lgb-lambdarank",
    *,
    walk_forward: bool = True,
    seed: int = 42,
    job_id: UUID | None = None,
    hyperparams: dict[str, Any] | None = None,
    walk_forward_params: dict[str, Any] | None = None,
    with_shap: bool = True,
) -> TrainResult:
    """完整训练通路。

    M3 默认 walk_forward=True，跑 Purged Walk-Forward + 三组对照 + 集成；
    walk_forward=False 走 M2 单 fold 通路。

    walk_forward_params 可选字段：
        n_folds (默认 6) / embargo_days (默认 21) / min_train_days (默认 252)
        top_k (默认 20) / commission_rate (默认 0.0003) / slippage_bps (默认 5)
        lgb_num_boost_round / lgb_early_stopping_rounds
    """

    if model != "lgb-lambdarank":
        raise ValueError(
            f"M2/M3 只支持 model='lgb-lambdarank'（其它后续里程碑接入），got {model!r}"
        )

    if job_id is not None:
        update_progress(job_id, 0, stage="train:start")

    # ---- 1. 数据加载 ----
    df = _load_feature_matrix(feature_set_id)
    df = df.sort_values(["trade_date", "ts_code"]).reset_index(drop=True)

    latest_trade_date = _latest_trade_date_from_features(df)
    gate_check(latest_trade_date, mode="training_pregate", strict=True, job_id=job_id)

    if job_id is not None:
        update_progress(job_id, 10, stage="train:data_loaded")

    X_all, feature_cols = _flatten_features(df)
    y_all = df["label"]
    valid_mask = y_all.notna()
    if int(valid_mask.sum()) < 20:
        raise ValueError(
            f"feature_set_id={feature_set_id} 有效样本数 {int(valid_mask.sum())} < 20，无法训练"
        )
    df_train = df.loc[valid_mask].reset_index(drop=True)
    X_all = X_all.loc[valid_mask].reset_index(drop=True)
    y_all = y_all.loc[valid_mask].reset_index(drop=True)

    if walk_forward:
        from quant_pipeline.training.walk_forward_runner import train_walk_forward

        result = train_walk_forward(
            feature_set_id=feature_set_id,
            df_train=df_train,
            X_all=X_all,
            y_all=y_all,
            feature_cols=feature_cols,
            seed=seed,
            job_id=job_id,
            hyperparams=hyperparams,
            walk_forward_params=walk_forward_params or {},
            latest_trade_date=latest_trade_date,
            insert_model_run=_insert_model_run,
            write_artifact=_write_artifact,
        )
    else:
        result = _train_single_fold(
            feature_set_id=feature_set_id,
            df_train=df_train,
            X_all=X_all,
            y_all=y_all,
            feature_cols=feature_cols,
            seed=seed,
            job_id=job_id,
            hyperparams=hyperparams,
            latest_trade_date=latest_trade_date,
        )

    # M4 Part L 后置钩子：SHAP 解释（默认开；失败不阻塞主流程，写 quality_reports）
    if with_shap:
        try:
            from quant_pipeline.evaluation.shap_explainer import safely_explain_after_train

            safely_explain_after_train(
                result.model_run_id,
                trade_date=latest_trade_date,
                job_id=job_id,
            )
        except Exception as exc:  # noqa: BLE001
            logger.warning(
                "shap_post_train_hook_failed",
                extra={"model_run_id": str(result.model_run_id), "err": str(exc)},
            )

    return result


# ----------------------------------------------------------------------
# M2 单 fold 通路（保留）
# ----------------------------------------------------------------------


def _train_single_fold(
    *,
    feature_set_id: str,
    df_train: pd.DataFrame,
    X_all: pd.DataFrame,
    y_all: pd.Series,
    feature_cols: list[str],
    seed: int,
    job_id: UUID | None,
    hyperparams: dict[str, Any] | None,
    latest_trade_date: str,
) -> TrainResult:
    splitter = SingleFoldSplit(train_ratio=0.7, embargo_days=0)
    (train_idx, test_idx) = next(splitter.split(df_train))

    X_train = X_all.iloc[train_idx].reset_index(drop=True)
    y_train = y_all.iloc[train_idx].reset_index(drop=True)
    df_train_part = df_train.iloc[train_idx].reset_index(drop=True)
    groups_train = _build_groups(df_train_part)

    X_test = X_all.iloc[test_idx].reset_index(drop=True)
    y_test = y_all.iloc[test_idx].reset_index(drop=True)
    df_test_part = df_train.iloc[test_idx].reset_index(drop=True)
    groups_test = _build_groups(df_test_part)

    booster = train_lambdarank(
        X_train,
        y_train,
        groups_train,
        valid_data=(X_test, y_test, groups_test),
        hyperparams=hyperparams,
        seed=seed,
        early_stopping_rounds=DEFAULT_EARLY_STOPPING_ROUNDS,
        num_boost_round=DEFAULT_NUM_BOOST_ROUND,
    )

    if job_id is not None:
        update_progress(job_id, 50, stage="train:fit_done")

    scores_test = booster.predict(X_test.values)
    ndcg10 = _ndcg_at_k(scores_test, y_test.to_numpy(), groups_test, k=10)
    ndcg5 = _ndcg_at_k(scores_test, y_test.to_numpy(), groups_test, k=5)
    ic = _pearson_ic(scores_test, y_test.to_numpy())
    rank_ic = _spearman_rank_ic(scores_test, y_test.to_numpy())

    oos_metrics: dict[str, Any] = {
        "ndcg@5": ndcg5,
        "ndcg@10": ndcg10,
        "ic": ic,
        "rank_ic": rank_ic,
        "portfolio_annual_after_cost": None,
        "fold_metrics": [
            {"fold": 0, "ndcg@10": ndcg10, "ndcg@5": ndcg5, "ic": ic, "rank_ic": rank_ic}
        ],
        "n_train": int(len(X_train)),
        "n_test": int(len(X_test)),
        "n_test_groups": int(len(groups_test)),
        "walk_forward": False,
    }

    if job_id is not None:
        update_progress(job_id, 75, stage="train:eval_done")

    run_id = uuid4()
    today_yyyymmdd = datetime.now(timezone.utc).strftime("%Y%m%d")
    model_version = f"lgb-lambdarank-v1-{today_yyyymmdd}-seed{seed}"

    used_hp: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        used_hp.update(hyperparams)
    used_hp["num_boost_round"] = DEFAULT_NUM_BOOST_ROUND
    used_hp["best_iteration"] = int(booster.best_iteration or booster.current_iteration())
    used_hp["seed"] = seed

    train_dates_used = sorted(df_train_part["trade_date"].astype(str).unique().tolist())
    valid_dates_used = sorted(df_test_part["trade_date"].astype(str).unique().tolist())

    meta = {
        "model_run_id": str(run_id),
        "model_version": model_version,
        "feature_set_id": feature_set_id,
        "feature_columns": feature_cols,
        "feature_columns_order": feature_cols,
        "factor_ids": feature_cols,
        "hyperparams": used_hp,
        "oos_metrics": oos_metrics,
        "trained_at_utc": datetime.now(timezone.utc).isoformat(),
        "latest_train_date": latest_trade_date,
        "train_dates": train_dates_used,
        "valid_dates": valid_dates_used,
        "seed": seed,
    }

    model_uri, _meta_uri = _write_artifact(run_id, booster, meta)

    try:
        _insert_model_run(
            run_id,
            job_id=job_id,
            model_version=model_version,
            feature_set_id=feature_set_id,
            hyperparams=used_hp,
            oos_metrics=oos_metrics,
            artifact_uri_str=model_uri,
        )
    except Exception:
        try:
            shutil.rmtree(artifact_dir(run_id), ignore_errors=True)
        except Exception:  # noqa: BLE001
            pass
        raise

    if job_id is not None:
        update_progress(job_id, 100, stage="train:done")

    logger.info(
        "train_done",
        extra={
            "model_run_id": str(run_id),
            "model_version": model_version,
            "ndcg@10": ndcg10,
            "ic": ic,
            "n_train": int(len(X_train)),
            "n_test": int(len(X_test)),
        },
    )

    return TrainResult(
        model_run_id=run_id,
        model_version=model_version,
        artifact_uri=model_uri,
        oos_metrics=oos_metrics,
    )


# ----------------------------------------------------------------------
# Dispatcher 入口
# ----------------------------------------------------------------------


def runner_entrypoint(job: Any) -> None:
    """供 worker.dispatcher 调用：从 job.params 解析参数后转 train_model。

    params schema（01-pg-schema §4.1）：
        {
            "feature_set_id": "fs_v1",
            "model": "lgb-lambdarank",          # optional, default lgb-lambdarank
            "walk_forward": true,               # optional, default true (M3)
            "seed": 42,                         # optional, default 42
            "hyperparams": {...},               # optional
            "walk_forward_params": {...}        # optional (n_folds / embargo_days / ...)
        }
    """

    params = getattr(job, "params", {}) or {}
    feature_set_id = params.get("feature_set_id")
    if not isinstance(feature_set_id, str) or not feature_set_id:
        raise ValueError(
            f"train job.params.feature_set_id 必须是非空字符串，got {feature_set_id!r}"
        )
    model = str(params.get("model", "lgb-lambdarank"))
    walk_forward = bool(params.get("walk_forward", True))
    seed = int(params.get("seed", 42))
    # M4 Part A：params.skip_shap=true 跳过 SHAP 后置钩子（用于 Optuna 快速 trial）
    with_shap = not bool(params.get("skip_shap", False))

    train_model(
        feature_set_id=feature_set_id,
        model=model,
        walk_forward=walk_forward,
        seed=seed,
        job_id=getattr(job, "id", None),
        hyperparams=params.get("hyperparams"),
        walk_forward_params=params.get("walk_forward_params"),
        with_shap=with_shap,
    )


# 兼容 M2 命名
train_one_fold = train_model

__all__ = [
    "ArtifactWriteError",
    "TrainResult",
    "train_model",
    "train_one_fold",
    "runner_entrypoint",
]
