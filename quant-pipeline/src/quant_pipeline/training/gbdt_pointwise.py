"""GBDT pointwise baseline（M3 三组对照之二）。

> doc/量化/05-LightGBM训练体系.md §5.8：与 LambdaRank 同为 GBDT 但目标函数不同
> 区分点：LambdaRank 直接优化排序（NDCG），pointwise 优化 MSE/L2；
> 用于验证"是排序学的好"还是"模型本身就强"。

接口契约（与 linear_baseline / lightgbm_lambdarank 对齐）：
    train(X, y, groups, hyperparams) -> Booster
    predict(booster, X) -> np.ndarray
"""

from __future__ import annotations

import logging
from typing import Any

import lightgbm as lgb
import numpy as np
from pandas import DataFrame, Series

logger = logging.getLogger(__name__)


# 5 个主要超参（spec Done 报回要求对照表）
DEFAULT_HYPERPARAMS: dict[str, Any] = {
    "objective": "regression",
    "metric": "rmse",
    "boosting_type": "gbdt",
    "num_leaves": 31,
    "max_depth": -1,
    "min_data_in_leaf": 200,
    "learning_rate": 0.05,
    "feature_fraction": 0.85,
    "bagging_fraction": 0.85,
    "bagging_freq": 5,
    "verbose": -1,
    "force_col_wise": True,
}

DEFAULT_NUM_BOOST_ROUND = 500
DEFAULT_EARLY_STOPPING_ROUNDS = 50


def train_gbdt_pointwise(
    X: DataFrame,
    y: Series,
    groups: np.ndarray | None = None,
    hyperparams: dict[str, Any] | None = None,
    *,
    valid_data: tuple[DataFrame, Series, np.ndarray | None] | None = None,
    num_boost_round: int = DEFAULT_NUM_BOOST_ROUND,
    early_stopping_rounds: int | None = DEFAULT_EARLY_STOPPING_ROUNDS,
    seed: int = 42,
) -> lgb.Booster:
    """LightGBM pointwise 回归。

    Args:
        X / y: 训练数据
        groups: 与 LambdaRank 接口对齐，本实现不使用（regression 无 query group）
        hyperparams: 覆盖 DEFAULT_HYPERPARAMS
        valid_data: 可选 (X_valid, y_valid, groups_valid)；传入即启用早停
        num_boost_round / early_stopping_rounds / seed: 见 lightgbm_lambdarank
    """

    if len(X) != len(y):
        raise ValueError(f"len(X)={len(X)} != len(y)={len(y)}")
    if X.shape[0] == 0:
        raise ValueError("X 为空，无法训练 gbdt pointwise")

    params: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        params.update(hyperparams)
    params.setdefault("seed", seed)
    params.setdefault("deterministic", True)

    feature_names = [str(c) for c in X.columns]
    train_set = lgb.Dataset(
        X.values,
        label=y.values,
        feature_name=feature_names,
        free_raw_data=False,
    )

    valid_sets: list[lgb.Dataset] = []
    valid_names: list[str] = []
    if valid_data is not None:
        eval_X, eval_y, _eval_groups = valid_data
        valid_set = lgb.Dataset(
            eval_X.values,
            label=eval_y.values,
            feature_name=feature_names,
            reference=train_set,
            free_raw_data=False,
        )
        valid_sets.append(valid_set)
        valid_names.append("valid")

    callbacks: list[Any] = []
    if early_stopping_rounds and valid_sets:
        callbacks.append(
            lgb.early_stopping(stopping_rounds=int(early_stopping_rounds), verbose=False)
        )
    callbacks.append(lgb.log_evaluation(period=0))

    booster = lgb.train(
        params=params,
        train_set=train_set,
        num_boost_round=int(num_boost_round),
        valid_sets=valid_sets if valid_sets else None,
        valid_names=valid_names if valid_names else None,
        callbacks=callbacks,
    )
    return booster


def predict_gbdt_pointwise(booster: lgb.Booster, X: DataFrame) -> np.ndarray:
    return np.asarray(booster.predict(X.values), dtype=np.float64)


__all__ = [
    "DEFAULT_HYPERPARAMS",
    "DEFAULT_NUM_BOOST_ROUND",
    "DEFAULT_EARLY_STOPPING_ROUNDS",
    "train_gbdt_pointwise",
    "predict_gbdt_pointwise",
]
