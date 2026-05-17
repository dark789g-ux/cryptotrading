"""Linear baseline 单测（M3 Part I）。

覆盖：
  - train_linear 产出 LinearPredictor，predict 输出长度对
  - 拟合带噪声的线性关系，RankIC > 0.5
  - X 含 NaN 也能拟合（自动填 0）
  - feature_columns 缺失抛 ValueError
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training.linear_baseline import (
    DEFAULT_HYPERPARAMS,
    LinearPredictor,
    predict_linear,
    train_linear,
)


def test_default_hyperparams_five_keys() -> None:
    for k in ["alpha", "fit_intercept", "max_iter", "tol", "solver"]:
        assert k in DEFAULT_HYPERPARAMS


def test_train_linear_produces_predictor_and_predicts() -> None:
    rng = np.random.default_rng(42)
    X = pd.DataFrame(rng.normal(size=(200, 5)), columns=[f"f{i}" for i in range(5)])
    y = pd.Series(X["f0"] * 2.0 + X["f1"] * -1.0 + rng.normal(scale=0.1, size=200))

    predictor = train_linear(X, y)
    assert isinstance(predictor, LinearPredictor)
    preds = predict_linear(predictor, X)
    assert preds.shape == (200,)
    assert np.isfinite(preds).all()


def test_train_linear_rank_ic_high_on_clean_data() -> None:
    rng = np.random.default_rng(0)
    X = pd.DataFrame(rng.normal(size=(500, 3)), columns=["a", "b", "c"])
    y = pd.Series(X["a"] * 3.0 - X["b"] + rng.normal(scale=0.05, size=500))
    predictor = train_linear(X, y)
    preds = predict_linear(predictor, X)
    # 线性关系强，RankIC 应 > 0.9
    corr = pd.Series(preds).rank().corr(y.rank())
    assert corr > 0.9, f"rank corr={corr}"


def test_train_linear_handles_nan_in_X() -> None:
    rng = np.random.default_rng(1)
    X = pd.DataFrame(rng.normal(size=(100, 3)), columns=["a", "b", "c"])
    X.iloc[5:10, 0] = np.nan
    y = pd.Series(rng.normal(size=100))
    predictor = train_linear(X, y)
    preds = predict_linear(predictor, X)
    assert np.isfinite(preds).all()


def test_predict_linear_missing_column_raises() -> None:
    rng = np.random.default_rng(2)
    X = pd.DataFrame(rng.normal(size=(50, 2)), columns=["a", "b"])
    y = pd.Series(rng.normal(size=50))
    predictor = train_linear(X, y)
    X_bad = pd.DataFrame({"a": [1, 2, 3]})  # 缺 b
    with pytest.raises(ValueError, match="缺失特征列"):
        predict_linear(predictor, X_bad)


def test_train_linear_empty_input_raises() -> None:
    X = pd.DataFrame({"a": []})
    y = pd.Series([], dtype=float)
    with pytest.raises(ValueError):
        train_linear(X, y)
