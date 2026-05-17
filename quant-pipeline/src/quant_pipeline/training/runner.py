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
from quant_pipeline.evaluation.ab_compare import MODEL_NAMES, compare_three
from quant_pipeline.evaluation.portfolio import compute_portfolio_metrics
from quant_pipeline.evaluation.report_generator import generate_report
from quant_pipeline.quality.report import gate_check
from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_EARLY_STOPPING_ROUNDS,
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)
from quant_pipeline.training.walk_forward import (
    PurgedWalkForwardSplit,
    SingleFoldSplit,
)
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
        return _train_walk_forward(
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
        )
    else:
        return _train_single_fold(
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
# M3 Walk-Forward + 三组对照 + 集成
# ----------------------------------------------------------------------


def _train_walk_forward(
    *,
    feature_set_id: str,
    df_train: pd.DataFrame,
    X_all: pd.DataFrame,
    y_all: pd.Series,
    feature_cols: list[str],
    seed: int,
    job_id: UUID | None,
    hyperparams: dict[str, Any] | None,
    walk_forward_params: dict[str, Any],
    latest_trade_date: str,
) -> TrainResult:
    wf_n_folds = int(walk_forward_params.get("n_folds", 6))
    wf_embargo_days = int(walk_forward_params.get("embargo_days", 21))
    wf_min_train_days = int(walk_forward_params.get("min_train_days", 252))
    top_k = int(walk_forward_params.get("top_k", 20))
    commission_rate = float(walk_forward_params.get("commission_rate", 0.0003))
    slippage_bps = float(walk_forward_params.get("slippage_bps", 5.0))
    lgb_num_boost_round = int(walk_forward_params.get("lgb_num_boost_round", DEFAULT_NUM_BOOST_ROUND))
    lgb_early_stopping_rounds = walk_forward_params.get("lgb_early_stopping_rounds")

    splitter = PurgedWalkForwardSplit(
        n_folds=wf_n_folds,
        embargo_days=wf_embargo_days,
        min_train_days=wf_min_train_days,
    )
    splits = list(splitter.split(df_train))

    # progress：每折结束分配一档；从 10 起步到 90 结束（剩余给落盘 + 报告）
    progress_start = 10
    progress_end = 90

    def _fold_progress(done: int, total: int) -> None:
        if job_id is None or total <= 0:
            return
        pct = progress_start + (progress_end - progress_start) * done // total
        update_progress(job_id, int(pct), stage=f"train:wf_fold_{done}/{total}")

    summary = compare_three(
        df_train,
        X_all,
        y_all,
        iter(splits),
        seed=seed,
        top_k=top_k,
        commission_rate=commission_rate,
        slippage_bps=slippage_bps,
        lgb_hyperparams=hyperparams,
        lgb_num_boost_round=lgb_num_boost_round,
        lgb_early_stopping_rounds=lgb_early_stopping_rounds,
        progress_callback=_fold_progress,
    )

    if job_id is not None:
        update_progress(job_id, progress_end, stage="train:wf_done")

    # 选 ensemble 模型作为主导出的 "model.txt"？—— 但 ensemble 没有 booster。
    # 做法：以 LambdaRank 的整段（用全量训练数据再训一次的）booster 作为生产推理用 artifact，
    # 三组对照结果作为 oos_metrics 写库。
    # LambdaRank 要求 label 为整数 gain（同日截面 rank）
    from quant_pipeline.evaluation.ab_compare import _label_to_cross_sectional_rank

    final_groups = _build_groups(df_train)
    y_all_rank = _label_to_cross_sectional_rank(df_train, y_all)
    final_booster = train_lambdarank(
        X_all,
        y_all_rank,
        final_groups,
        hyperparams=hyperparams,
        seed=seed,
        num_boost_round=lgb_num_boost_round,
        early_stopping_rounds=None,
    )

    # 合成 oos_metrics
    primary = summary.get("lgb-lambdarank", {})
    ensemble_summary = summary.get("ensemble", {})
    oos_metrics: dict[str, Any] = {
        "ndcg@5": primary.get("ndcg_at_5_mean", float("nan")),
        "ndcg@10": primary.get("ndcg_at_10_mean", float("nan")),
        "ic": primary.get("ic_mean", float("nan")),
        "rank_ic": primary.get("rank_ic_mean", float("nan")),
        "portfolio_annual_after_cost": primary.get(
            "portfolio_annual_after_cost", float("nan")
        ),
        "fold_metrics": primary.get("fold_metrics", []),
        "walk_forward": True,
        "walk_forward_params": {
            "n_folds": wf_n_folds,
            "embargo_days": wf_embargo_days,
            "min_train_days": wf_min_train_days,
        },
        "ab_summary": {
            name: {k: v for k, v in m.items() if k != "fold_metrics"}
            for name, m in summary.items()
        },
        "ensemble_metrics": {
            k: v for k, v in ensemble_summary.items() if k != "fold_metrics"
        },
        "models_compared": list(MODEL_NAMES),
    }

    # 命名 + artifact 落盘
    run_id = uuid4()
    today_yyyymmdd = datetime.now(timezone.utc).strftime("%Y%m%d")
    model_version = f"lgb-lambdarank-v1-{today_yyyymmdd}-seed{seed}"

    used_hp: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        used_hp.update(hyperparams)
    used_hp["num_boost_round"] = lgb_num_boost_round
    used_hp["best_iteration"] = int(
        final_booster.best_iteration or final_booster.current_iteration()
    )
    used_hp["seed"] = seed

    train_dates_used = sorted(df_train["trade_date"].astype(str).unique().tolist())

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
        "seed": seed,
        "walk_forward": True,
    }

    model_uri, _meta_uri = _write_artifact(run_id, final_booster, meta)

    # 生成报告 — 把 ensemble 模型在所有 fold test 上的合并 portfolio daily returns 落 csv
    daily_returns_combined = _build_ensemble_daily_returns(
        summary, df_train, X_all, y_all, splits,
        seed=seed,
        top_k=top_k,
        commission_rate=commission_rate,
        slippage_bps=slippage_bps,
        lgb_hyperparams=hyperparams,
        lgb_num_boost_round=lgb_num_boost_round,
    )

    report_uri: str | None = None
    try:
        _content, report_uri = generate_report(
            model_run_id=str(run_id),
            model_version=model_version,
            feature_set_id=feature_set_id,
            hyperparams=used_hp,
            walk_forward_params={
                "n_folds": wf_n_folds,
                "embargo_days": wf_embargo_days,
                "min_train_days": wf_min_train_days,
            },
            compare_summary=summary,
            ensemble_daily_returns=daily_returns_combined,
            output_dir=artifact_dir(run_id),
        )
    except Exception as exc:  # noqa: BLE001
        logger.warning(
            "report_generation_failed",
            extra={"model_run_id": str(run_id), "error": str(exc)},
        )

    if job_id is not None:
        update_progress(job_id, 95, stage="train:report_done")

    # 写库
    try:
        _insert_model_run(
            run_id,
            job_id=job_id,
            model_version=model_version,
            feature_set_id=feature_set_id,
            hyperparams=used_hp,
            oos_metrics=oos_metrics,
            artifact_uri_str=model_uri,
            report_uri_str=report_uri,
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
        "train_walk_forward_done",
        extra={
            "model_run_id": str(run_id),
            "model_version": model_version,
            "n_folds": wf_n_folds,
            "ndcg@10": primary.get("ndcg_at_10_mean"),
            "portfolio_annual_after_cost": primary.get("portfolio_annual_after_cost"),
        },
    )

    return TrainResult(
        model_run_id=run_id,
        model_version=model_version,
        artifact_uri=model_uri,
        oos_metrics=oos_metrics,
        report_uri=report_uri,
    )


def _build_ensemble_daily_returns(
    summary: dict[str, dict[str, Any]],
    df_train: pd.DataFrame,
    X_all: pd.DataFrame,
    y_all: pd.Series,
    splits: list[tuple[np.ndarray, np.ndarray]],
    *,
    seed: int,
    top_k: int,
    commission_rate: float,
    slippage_bps: float,
    lgb_hyperparams: dict[str, Any] | None,
    lgb_num_boost_round: int,
) -> pd.Series:
    """重跑一次三组模型 + ensemble 合成出 portfolio daily returns（合并所有 fold test 段）。

    报告生成需要"ensemble 在所有 OOS 段上的 daily returns"，最廉价的方法是直接重跑一次。
    若担心耗时，未来可在 compare_three 中缓存。
    """

    from quant_pipeline.training.ensemble import ensemble_average
    from quant_pipeline.training.gbdt_pointwise import (
        predict_gbdt_pointwise,
        train_gbdt_pointwise,
    )
    from quant_pipeline.training.linear_baseline import predict_linear, train_linear

    if not splits:
        return pd.Series(dtype=float)

    combined: list[pd.Series] = []
    for train_idx, test_idx in splits:
        X_train = X_all.iloc[train_idx].reset_index(drop=True)
        y_train = y_all.iloc[train_idx].reset_index(drop=True)
        X_test = X_all.iloc[test_idx].reset_index(drop=True)
        y_test = y_all.iloc[test_idx].reset_index(drop=True)
        df_test = df_train.iloc[test_idx].reset_index(drop=True)
        groups_train = _build_groups(df_train.iloc[train_idx].reset_index(drop=True))

        from quant_pipeline.evaluation.ab_compare import _label_to_cross_sectional_rank

        y_train_rank = _label_to_cross_sectional_rank(
            df_train.iloc[train_idx].reset_index(drop=True), y_train
        )
        lin = train_linear(X_train, y_train, seed=seed)
        s_lin = predict_linear(lin, X_test)
        gbdt = train_gbdt_pointwise(
            X_train, y_train, hyperparams=lgb_hyperparams,
            num_boost_round=lgb_num_boost_round, early_stopping_rounds=None, seed=seed,
        )
        s_gbdt = predict_gbdt_pointwise(gbdt, X_test)
        lr = train_lambdarank(
            X_train, y_train_rank, groups_train,
            hyperparams=lgb_hyperparams,
            num_boost_round=lgb_num_boost_round, early_stopping_rounds=None, seed=seed,
        )
        s_lr = np.asarray(lr.predict(X_test.values), dtype=np.float64)

        td = df_test["trade_date"].astype(str).to_numpy()
        ens = ensemble_average(
            {"linear": s_lin, "gbdt-pointwise": s_gbdt, "lgb-lambdarank": s_lr},
            td,
        )

        scores_df = pd.DataFrame(
            {"trade_date": td, "ts_code": df_test["ts_code"].to_numpy(), "score": ens}
        )
        label_df = pd.DataFrame(
            {"trade_date": td, "ts_code": df_test["ts_code"].to_numpy(), "label": y_test.to_numpy()}
        )
        port = compute_portfolio_metrics(
            scores_df, label_df,
            top_k=top_k, commission_rate=commission_rate, slippage_bps=slippage_bps,
        )
        combined.append(port["daily_returns"])

    if not combined:
        return pd.Series(dtype=float)
    return pd.concat(combined).sort_index()


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

    train_model(
        feature_set_id=feature_set_id,
        model=model,
        walk_forward=walk_forward,
        seed=seed,
        job_id=getattr(job, "id", None),
        hyperparams=params.get("hyperparams"),
        walk_forward_params=params.get("walk_forward_params"),
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
