"""M2 单 fold 训练通路（保留，仅供冷启动 / 调试）。

从 training/runner.py 拆出。`walk_forward=False` 时走本通路。

2026-05-23 修正（04-training 评审）：
  - #2：原 `_train_single_fold` 引用 `train_model` 的内部闭包 `_progress`，作用域错误
    导致单 fold 通路必崩 NameError。改为显式接收 `progress_callback` 参数。
  - #12：原通路把 (X_test, y_test) 作为 valid_data 启用早停，又在同一 test 段算 OOS
    指标 —— 早停用测试集选迭代轮数即测试集泄漏。本通路定位为调试用，直接关闭早停
    （early_stopping_rounds=None），不再传 valid_data。
  - #1：标签保持原始连续值；LambdaRank 需要的整数 gain 只在 train_lambdarank 入口
    处对 y_train 做一次截面 rank；评估（NDCG / IC / RankIC）一律用原始连续 label。
  - #7：today_yyyymmdd 支持注入，跨 UTC 午夜运行 model_version 可控。
"""

from __future__ import annotations

import logging
import shutil
from datetime import UTC, datetime
from typing import Any
from uuid import UUID, uuid4

import numpy as np
import pandas as pd

from quant_pipeline.evaluation.ranking_metrics import (
    ic_pearson,
    ndcg_at_k,
    rank_ic_spearman,
)
from quant_pipeline.training.group_utils import build_groups
from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)
from quant_pipeline.training.walk_forward import SingleFoldSplit
from quant_pipeline.utils.paths import artifact_dir
from quant_pipeline.worker.progress import ProgressCallback

logger = logging.getLogger(__name__)


def _label_to_cross_sectional_rank(
    df_meta: pd.DataFrame, y: pd.Series
) -> pd.Series:
    """把连续 label 按 trade_date 截面转为整数 rank（0..n-1）给 LambdaRank 当 gain。"""

    df = pd.DataFrame(
        {"td": df_meta["trade_date"].astype(str).to_numpy(), "y": y.to_numpy()}
    )
    ranks = df.groupby("td", sort=False)["y"].rank(method="first").astype(int) - 1
    ranks.index = y.index
    return ranks


def train_single_fold(
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
    insert_model_run: Any,
    write_artifact: Any,
    progress_callback: ProgressCallback,
    today_yyyymmdd: str | None = None,
) -> Any:
    """M2 单 fold 通路（70/30 切一刀）。

    Args:
        insert_model_run / write_artifact: runner 层回调（避免循环引用）
        progress_callback: 进度回调（必传；修复 #2 作用域错误）
        today_yyyymmdd: 可注入今天日期；默认 datetime.now(UTC)
    """

    from quant_pipeline.training.runner import TrainResult

    splitter = SingleFoldSplit(train_ratio=0.7, embargo_days=0)
    (train_idx, test_idx) = next(splitter.split(df_train))

    X_train = X_all.iloc[train_idx].reset_index(drop=True)
    y_train = y_all.iloc[train_idx].reset_index(drop=True)
    df_train_part = df_train.iloc[train_idx].reset_index(drop=True)
    groups_train = build_groups(df_train_part)
    # LambdaRank 需要整数 gain：仅对训练标签做截面 rank（评估仍用连续 label）
    y_train_rank = _label_to_cross_sectional_rank(df_train_part, y_train)

    X_test = X_all.iloc[test_idx].reset_index(drop=True)
    y_test = y_all.iloc[test_idx].reset_index(drop=True)
    df_test_part = df_train.iloc[test_idx].reset_index(drop=True)
    groups_test = build_groups(df_test_part)

    # #12：调试通路关闭早停，不传 valid_data，避免测试集泄漏。
    booster = train_lambdarank(
        X_train,
        y_train_rank,
        groups_train,
        valid_data=None,
        hyperparams=hyperparams,
        seed=seed,
        early_stopping_rounds=None,
        num_boost_round=DEFAULT_NUM_BOOST_ROUND,
    )

    progress_callback(50, "train:fit_done")

    # 评估一律用原始连续 label；评审 05-#6：传 DataFrame 让 LightGBM 按列名校验
    scores_test = np.asarray(booster.predict(X_test), dtype=np.float64)
    y_test_arr = y_test.to_numpy(dtype=np.float64)
    ndcg10 = ndcg_at_k(scores_test, y_test_arr, groups_test, k=10)
    ndcg5 = ndcg_at_k(scores_test, y_test_arr, groups_test, k=5)
    ic = ic_pearson(scores_test, y_test_arr)
    rank_ic = rank_ic_spearman(scores_test, y_test_arr)

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

    progress_callback(75, "train:eval_done")

    run_id = uuid4()
    today = today_yyyymmdd or datetime.now(UTC).strftime("%Y%m%d")
    model_version = f"lgb-lambdarank-v1-{today}-seed{seed}"

    used_hp: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        used_hp.update(hyperparams)
    used_hp["num_boost_round"] = DEFAULT_NUM_BOOST_ROUND
    # 无早停：best_iteration 恒为 num_boost_round，显式记录避免误读
    used_hp["best_iteration"] = DEFAULT_NUM_BOOST_ROUND
    used_hp["early_stopping"] = False
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
        "trained_at_utc": datetime.now(UTC).isoformat(),
        "latest_train_date": latest_trade_date,
        "train_dates": train_dates_used,
        "valid_dates": valid_dates_used,
        "seed": seed,
    }

    model_uri, _meta_uri = write_artifact(run_id, booster, meta)

    try:
        insert_model_run(
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

    progress_callback(100, "train:done")

    logger.info(
        "train_single_fold_done",
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


__all__ = ["train_single_fold"]
