"""线性 baseline（M3 三组对照之一）。

> doc/量化/05-LightGBM训练体系.md §5.8 三组对照实验：linear vs gbdt vs ensemble
> 用最简单的 Ridge 回归直接学 `label`，作为 GBDT/LambdaRank 的下限对照。
> 选股阶段对 Ridge 的连续分数按截面排名取 Top-K（评估层完成）。

接口契约（与 gbdt_pointwise / lightgbm_lambdarank 对齐）：
    train(X, y, groups, hyperparams) -> LinearPredictor
    predict(predictor, X) -> np.ndarray

约束：
- 与 LambdaRank 不同，Ridge 不需要 groups 排序（保留参数以对齐 ensemble 调度）
- 标签 NaN 在上层 runner 处过滤；本模块假定输入清洁
"""

from __future__ import annotations

import logging
from dataclasses import dataclass
from typing import Any

import numpy as np
from pandas import DataFrame, Series
from sklearn.linear_model import Ridge

logger = logging.getLogger(__name__)


# 5 个主要超参（spec Done 报回要求对照表）
DEFAULT_HYPERPARAMS: dict[str, Any] = {
    "alpha": 1.0,
    "fit_intercept": True,
    "max_iter": 1000,
    "tol": 1e-4,
    "solver": "auto",
}


@dataclass(slots=True)
class LinearPredictor:
    """Ridge baseline 的可序列化预测器。

    保存：拟合后的系数 / 截距 / 特征列名（保证 predict 时列对齐）。
    """

    model: Ridge
    feature_columns: list[str]
    hyperparams: dict[str, Any]


def train_linear(
    X: DataFrame,
    y: Series,
    groups: np.ndarray | None = None,
    hyperparams: dict[str, Any] | None = None,
    *,
    seed: int = 42,
) -> LinearPredictor:
    """Ridge 回归训练。

    Args:
        X: 特征 DataFrame（行=样本，列=特征）
        y: label Series（连续值）
        groups: 与 LambdaRank 接口对齐，本实现不使用
        hyperparams: 覆盖 DEFAULT_HYPERPARAMS
        seed: 不影响 Ridge（solver 是确定性），保留为接口一致

    Returns:
        LinearPredictor
    """

    if len(X) != len(y):
        raise ValueError(f"len(X)={len(X)} != len(y)={len(y)}")
    if X.shape[0] == 0:
        raise ValueError("X 为空，无法训练 linear baseline")

    params: dict[str, Any] = dict(DEFAULT_HYPERPARAMS)
    if hyperparams:
        params.update(hyperparams)
    # seed 写到 hyperparams 元数据但不传 Ridge
    params_for_model = {k: v for k, v in params.items()}

    # 用 0 填充 NaN（Ridge 不接受 NaN；上层 runner 已过滤 label NaN，但 X 可能含 NaN）。
    # 评审 04-#16：对未标准化的原始量纲因子，fillna(0.0) 不是中性填充（0 可能落在
    # 因子分布的极端位置）；GBDT/LambdaRank 原生支持 NaN，三组对照的输入口径并不一致。
    # 短期无法统一口径，至少把 NaN 比例 warn 出来让数据质量可见。
    n_cells = int(X.size)
    n_nan = int(X.isna().to_numpy().sum()) if n_cells > 0 else 0
    if n_nan > 0:
        logger.warning(
            "linear_baseline_feature_nan_filled_with_zero",
            extra={
                "n_nan_cells": n_nan,
                "n_total_cells": n_cells,
                "nan_ratio": round(n_nan / n_cells, 6) if n_cells > 0 else 0.0,
                "note": "fillna(0.0) 对原始量纲因子非中性；与 GBDT/LambdaRank 原生 NaN 口径不一致",
            },
        )
    X_clean = X.fillna(0.0).to_numpy(dtype=np.float64)
    y_clean = y.to_numpy(dtype=np.float64)

    model = Ridge(**params_for_model)
    model.fit(X_clean, y_clean)

    return LinearPredictor(
        model=model,
        feature_columns=[str(c) for c in X.columns],
        hyperparams={**params, "seed": seed},
    )


def predict_linear(predictor: LinearPredictor, X: DataFrame) -> np.ndarray:
    """对齐特征列后做预测。"""

    missing = [c for c in predictor.feature_columns if c not in X.columns]
    if missing:
        raise ValueError(f"predict 输入缺失特征列: {missing[:5]}...")
    X_aligned = X[predictor.feature_columns].fillna(0.0).to_numpy(dtype=np.float64)
    return predictor.model.predict(X_aligned)


__all__ = [
    "DEFAULT_HYPERPARAMS",
    "LinearPredictor",
    "train_linear",
    "predict_linear",
]
