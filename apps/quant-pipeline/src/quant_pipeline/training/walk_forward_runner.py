"""Walk-Forward 训练 + ensemble daily returns 构建。

从 training/runner.py 拆出的 M3 Walk-Forward 通路。
"""

from __future__ import annotations

import logging
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import pandas as pd

from quant_pipeline.evaluation.ab_compare import MODEL_NAMES, compare_three
from quant_pipeline.evaluation.portfolio import compute_portfolio_metrics
from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)
from quant_pipeline.training.walk_forward import PurgedWalkForwardSplit
from quant_pipeline.utils.paths import (
    artifact_dir,
    artifact_uri,
    ensure_artifact_dir,
)
from quant_pipeline.worker.progress import update_progress

logger = logging.getLogger(__name__)


def build_groups(df: pd.DataFrame) -> np.ndarray:
    """以 trade_date 为 query group；返回每日样本数数组（顺序与 df 一致）。"""

    counts = df.groupby("trade_date", sort=False).size().to_numpy()
    return counts.astype(np.int64)


def train_walk_forward(
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
    insert_model_run: Any,
    write_artifact: Any,
) -> Any:
    """M3 Walk-Forward + 三组对照 + 集成。

    Args:
        insert_model_run: runner._insert_model_run 回调（避免循环引用）
        write_artifact: runner._write_artifact 回调
    """

    from quant_pipeline.training.runner import TrainResult

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

    # 以 LambdaRank 整段 booster 作为生产推理用 artifact
    from quant_pipeline.evaluation.ab_compare import _label_to_cross_sectional_rank

    final_groups = build_groups(df_train)
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
    from datetime import datetime, timezone

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

    model_uri, _meta_uri = write_artifact(run_id, final_booster, meta)

    # 生成报告
    daily_returns_combined = build_ensemble_daily_returns(
        summary, df_train, X_all, y_all, splits,
        seed=seed,
        top_k=top_k,
        commission_rate=commission_rate,
        slippage_bps=slippage_bps,
        lgb_hyperparams=hyperparams,
        lgb_num_boost_round=lgb_num_boost_round,
    )

    from quant_pipeline.evaluation.report_generator import generate_report

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
    import shutil as _shutil

    try:
        insert_model_run(
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
            _shutil.rmtree(artifact_dir(run_id), ignore_errors=True)
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


def build_ensemble_daily_returns(
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
        groups_train = build_groups(df_train.iloc[train_idx].reset_index(drop=True))

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
