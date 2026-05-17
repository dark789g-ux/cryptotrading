"""GBDT pointwise 单测（M3 Part I）。

覆盖：
  - DEFAULT_HYPERPARAMS objective='regression'
  - train_gbdt_pointwise 产出 Booster
  - 带 valid_data + 早停
  - 输入长度校验
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training.gbdt_pointwise import (
    DEFAULT_HYPERPARAMS,
    predict_gbdt_pointwise,
    train_gbdt_pointwise,
)


def test_default_hyperparams_regression() -> None:
    assert DEFAULT_HYPERPARAMS["objective"] == "regression"
    assert DEFAULT_HYPERPARAMS["metric"] == "rmse"
    assert DEFAULT_HYPERPARAMS["boosting_type"] == "gbdt"


def test_train_gbdt_pointwise_produces_booster() -> None:
    rng = np.random.default_rng(42)
    X = pd.DataFrame(rng.normal(size=(200, 5)), columns=[f"f{i}" for i in range(5)])
    y = pd.Series(X["f0"] * 2.0 + rng.normal(scale=0.1, size=200))

    booster = train_gbdt_pointwise(
        X,
        y,
        hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        num_boost_round=50,
        early_stopping_rounds=None,
        seed=42,
    )
    assert booster is not None
    preds = predict_gbdt_pointwise(booster, X)
    assert preds.shape == (200,)
    assert np.isfinite(preds).all()


def test_train_gbdt_pointwise_with_valid_data_early_stopping() -> None:
    rng = np.random.default_rng(0)
    X = pd.DataFrame(rng.normal(size=(200, 3)), columns=["a", "b", "c"])
    y = pd.Series(X["a"] * 2 + rng.normal(scale=0.1, size=200))
    X_va, y_va = X.iloc[150:], y.iloc[150:]

    booster = train_gbdt_pointwise(
        X.iloc[:150],
        y.iloc[:150],
        hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        valid_data=(X_va, y_va, None),
        num_boost_round=200,
        early_stopping_rounds=10,
    )
    assert booster is not None
    assert booster.best_iteration is None or booster.best_iteration <= 200


def test_train_gbdt_pointwise_length_mismatch() -> None:
    X = pd.DataFrame({"a": [1.0, 2.0, 3.0]})
    y = pd.Series([1.0, 2.0])
    with pytest.raises(ValueError, match="len"):
        train_gbdt_pointwise(X, y, num_boost_round=5)


def test_train_gbdt_pointwise_better_than_random() -> None:
    rng = np.random.default_rng(7)
    X = pd.DataFrame(rng.normal(size=(500, 3)), columns=["a", "b", "c"])
    y = pd.Series(X["a"] * 5.0 + rng.normal(scale=0.5, size=500))
    booster = train_gbdt_pointwise(
        X,
        y,
        hyperparams={"min_data_in_leaf": 5, "num_leaves": 15},
        num_boost_round=100,
        early_stopping_rounds=None,
    )
    preds = predict_gbdt_pointwise(booster, X)
    corr = pd.Series(preds).corr(y)
    assert corr > 0.5
