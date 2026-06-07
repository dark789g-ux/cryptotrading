"""Walk-Forward 训练 + ensemble daily returns 构建。

从 training/runner.py 拆出的 M3 Walk-Forward 通路。
"""

from __future__ import annotations

import logging
from datetime import UTC
from typing import Any
from uuid import UUID, uuid4

import pandas as pd

from quant_pipeline.evaluation.ab_compare import MODEL_NAMES, compare_three
from quant_pipeline.training.group_utils import build_groups, label_to_bucketed_gain
from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)
from quant_pipeline.training.walk_forward import PurgedWalkForwardSplit
from quant_pipeline.utils.paths import artifact_dir
from quant_pipeline.worker.progress import update_progress

logger = logging.getLogger(__name__)

# summary 内不能进 JSON（oos_metrics）的 key：fold_metrics 是明细列表、
# daily_returns_combined 是 pd.Series（评审 04-#6 新增）。
_NON_JSON_SUMMARY_KEYS = {"fold_metrics", "daily_returns_combined"}


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
    progress_callback: Any = None,
    today_yyyymmdd: str | None = None,
) -> Any:
    """M3 Walk-Forward + 三组对照 + 集成。

    Args:
        insert_model_run: runner._insert_model_run 回调（避免循环引用）
        write_artifact: runner._write_artifact 回调
        today_yyyymmdd: 可注入今天日期（YYYYMMDD），用于 model_version；
            默认 None 时取 datetime.now(UTC)（评审 04-#7：跨 UTC 午夜可控）
    """

    from quant_pipeline.training.runner import TrainResult

    wf_n_folds = int(walk_forward_params.get("n_folds", 6))
    wf_embargo_days = int(walk_forward_params.get("embargo_days", 21))
    wf_min_train_days = int(walk_forward_params.get("min_train_days", 252))
    top_k = int(walk_forward_params.get("top_k", 20))
    commission_rate = float(walk_forward_params.get("commission_rate", 0.0003))
    slippage_bps = float(walk_forward_params.get("slippage_bps", 5.0))
    lgb_num_boost_round = int(
        walk_forward_params.get("lgb_num_boost_round", DEFAULT_NUM_BOOST_ROUND)
    )
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
        if total <= 0:
            return
        pct = progress_start + (progress_end - progress_start) * done // total
        stage = f"train:wf_fold_{done}/{total}"
        if progress_callback is not None:
            progress_callback(int(pct), stage)
        if job_id is not None:
            update_progress(job_id, int(pct), stage=stage)

    summary = compare_three(
        df_train,
        X_all,
        y_all,
        iter(splits),
        seed=seed,
        top_k=top_k,
        commission_rate=commission_rate,
        slippage_bps=slippage_bps,
        # #3：透传 label_scheme，让 portfolio Sharpe 按该标签方案的实际持仓视界年化
        # （train_e2e 经 extra_hyperparams 把 label_scheme 注入 hyperparams；旧调用方
        # 不含该键时为 None，compare_three 回退默认 avg_hold_days=10，向后兼容）。
        label_scheme=(hyperparams or {}).get("label_scheme"),
        lgb_hyperparams=hyperparams,
        lgb_num_boost_round=lgb_num_boost_round,
        lgb_early_stopping_rounds=lgb_early_stopping_rounds,
        progress_callback=_fold_progress,
    )

    if job_id is not None:
        update_progress(job_id, progress_end, stage="train:wf_done")

    # 以 LambdaRank 整段 booster 作为生产推理用 artifact。
    # 修复(followup label_gain 崩溃):LambdaRank label 必须是有界整数 gain。0aca2d5
    # "移除标签双重变换"时把这里的截面 rank 误删,直喂原始连续含负 y_all 会触发
    # "label should be int type"(崩B);且应与评估折/NDCG 同口径——故同走截面分位分桶。
    final_groups = build_groups(df_train)
    y_all_gain = label_to_bucketed_gain(df_train, y_all)
    final_booster = train_lambdarank(
        X_all,
        y_all_gain,
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
        # 排除 fold_metrics（明细另存）与 daily_returns_combined（pd.Series 不可 JSON）
        "ab_summary": {
            name: {k: v for k, v in m.items() if k not in _NON_JSON_SUMMARY_KEYS}
            for name, m in summary.items()
        },
        "ensemble_metrics": {
            k: v for k, v in ensemble_summary.items() if k not in _NON_JSON_SUMMARY_KEYS
        },
        "models_compared": list(MODEL_NAMES),
    }

    # 命名 + artifact 落盘
    run_id = uuid4()
    from datetime import datetime

    today = today_yyyymmdd or datetime.now(UTC).strftime("%Y%m%d")
    model_version = f"lgb-lambdarank-v1-{today}-seed{seed}"

    used_hp: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        used_hp.update(hyperparams)
    used_hp["num_boost_round"] = lgb_num_boost_round
    # 评审 04-#5：final_booster 用全量数据训练且关闭早停（early_stopping_rounds=None），
    # best_iteration 恒为 0 → current_iteration() = num_boost_round。无早停时
    # best_iteration 无意义，直接记 num_boost_round 并标注 early_stopping=False。
    used_hp["best_iteration"] = lgb_num_boost_round
    used_hp["early_stopping"] = False
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
        "trained_at_utc": datetime.now(UTC).isoformat(),
        "latest_train_date": latest_trade_date,
        "train_dates": train_dates_used,
        "seed": seed,
        "walk_forward": True,
    }

    model_uri, _meta_uri = write_artifact(run_id, final_booster, meta)

    # 生成报告
    # 评审 04-#6：ensemble OOS daily returns 由 compare_three 在每折评估时已算出并
    # 累积到 summary["ensemble"]["daily_returns_combined"]，直接取用，不再重训三组模型。
    daily_returns_combined = ensemble_summary.get(
        "daily_returns_combined", pd.Series(dtype=float)
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


# 评审 04-#6：原 `build_ensemble_daily_returns` 会重训 6 折 × 3 模型再算一遍
# ensemble portfolio daily returns（翻倍训练成本，且重训时 LambdaRank 误用了未做
# 截面 rank 的连续 label）。已删除：compare_three 在每折评估时直接累积 ensemble 的
# 逐笔 trade 净收益到 summary["ensemble"]["daily_returns_combined"]。
