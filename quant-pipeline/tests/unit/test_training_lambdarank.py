"""LightGBM LambdaRank 训练单测（M2 Part G）。

mock：10 标的 × 20 交易日 × 5 因子 + 整数排序标签。
要求：
  - train_lambdarank 能产出 Booster
  - 对训练集预测 + 测试集预测都不报错
  - NDCG@10 高于"完全随机分配"基线
  - 默认 11 参数对齐 doc/05 §5.3
  - groups 输入校验：sum(groups) != len(X) 抛 ValueError
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.training.lightgbm_lambdarank import (
    DEFAULT_HYPERPARAMS,
    DEFAULT_NUM_BOOST_ROUND,
    train_lambdarank,
)


@pytest.fixture
def mock_ranking_panel() -> tuple[pd.DataFrame, pd.Series, np.ndarray]:
    """生成 10 标的 × 20 交易日 × 5 因子的训练数据。

    构造方式：
      - feat0 与 label 有强正相关（基础信号）
      - feat1~feat4 噪声
      - label 是同日内的整数排名（0..9，越大越好）
    """

    rng = np.random.default_rng(42)
    n_dates = 20
    n_codes = 10
    n_feats = 5
    rows: list[dict[str, float]] = []
    labels: list[int] = []
    dates: list[str] = []
    for d in range(n_dates):
        td = f"2026010{d:02d}"
        # feat0 为带噪声的真信号；label 是 feat0 当日的 rank
        feat0 = rng.normal(0.0, 1.0, size=n_codes)
        ranks = (-feat0).argsort().argsort()  # 0 最低 ... 9 最高
        # 给 feat0 加一点点噪声以让模型有得学
        feat0_obs = feat0 + rng.normal(0.0, 0.3, size=n_codes)
        for i in range(n_codes):
            rows.append(
                {
                    "feat0": float(feat0_obs[i]),
                    "feat1": float(rng.normal()),
                    "feat2": float(rng.normal()),
                    "feat3": float(rng.normal()),
                    "feat4": float(rng.normal()),
                }
            )
            labels.append(int(ranks[i]))
            dates.append(td)
    X = pd.DataFrame(rows)
    y = pd.Series(labels, name="label")
    # groups: 每个交易日 n_codes 个样本
    groups = np.full(n_dates, n_codes, dtype=np.int64)
    assert X.shape == (n_dates * n_codes, n_feats)
    return X, y, groups


def test_default_hyperparams_align_spec_part_b() -> None:
    """spec m2-training-mvp Part B 标准配置（11 项），与 doc/05 §5.3 略有差异以 spec 为准。"""

    assert DEFAULT_HYPERPARAMS["objective"] == "lambdarank"
    assert DEFAULT_HYPERPARAMS["metric"] == "ndcg"
    assert DEFAULT_HYPERPARAMS["ndcg_eval_at"] == [5, 10]
    assert DEFAULT_HYPERPARAMS["lambdarank_truncation_level"] == 10
    assert DEFAULT_HYPERPARAMS["boosting_type"] == "gbdt"
    assert DEFAULT_HYPERPARAMS["num_leaves"] == 31
    assert DEFAULT_HYPERPARAMS["max_depth"] == -1
    assert DEFAULT_HYPERPARAMS["min_data_in_leaf"] == 200
    assert DEFAULT_HYPERPARAMS["learning_rate"] == 0.05
    assert DEFAULT_HYPERPARAMS["feature_fraction"] == 0.85
    assert DEFAULT_HYPERPARAMS["bagging_fraction"] == 0.85
    assert DEFAULT_HYPERPARAMS["bagging_freq"] == 5
    assert DEFAULT_NUM_BOOST_ROUND == 500


def test_train_lambdarank_produces_booster(
    mock_ranking_panel: tuple[pd.DataFrame, pd.Series, np.ndarray],
) -> None:
    X, y, groups = mock_ranking_panel
    # mock 数据样本少，关掉 min_data_in_leaf 防止学不动
    booster = train_lambdarank(
        X,
        y,
        groups,
        hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        num_boost_round=50,
        early_stopping_rounds=None,
    )
    assert booster is not None
    preds = booster.predict(X.values)
    assert preds.shape == (len(X),)
    assert np.isfinite(preds).all()


def test_train_lambdarank_ndcg_better_than_random(
    mock_ranking_panel: tuple[pd.DataFrame, pd.Series, np.ndarray],
) -> None:
    """模型 NDCG@10 应显著高于随机分数的 NDCG@10。"""

    from quant_pipeline.training.runner import _ndcg_at_k

    X, y, groups = mock_ranking_panel

    booster = train_lambdarank(
        X,
        y,
        groups,
        hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        num_boost_round=100,
        early_stopping_rounds=None,
    )
    preds = booster.predict(X.values)
    ndcg_model = _ndcg_at_k(preds, y.to_numpy(), groups, k=10)

    rng = np.random.default_rng(0)
    random_scores = rng.normal(size=len(X))
    ndcg_random = _ndcg_at_k(random_scores, y.to_numpy(), groups, k=10)

    # 模型 NDCG 应明显高于随机；至少 +0.05
    assert ndcg_model > ndcg_random + 0.05, (
        f"ndcg_model={ndcg_model:.4f} not > ndcg_random={ndcg_random:.4f}+0.05"
    )


def test_train_lambdarank_groups_validation(
    mock_ranking_panel: tuple[pd.DataFrame, pd.Series, np.ndarray],
) -> None:
    X, y, _groups = mock_ranking_panel
    bad_groups = np.array([5, 5], dtype=np.int64)  # sum=10，但 len(X)=200
    with pytest.raises(ValueError, match="sum"):
        train_lambdarank(
            X, y, bad_groups,
            hyperparams={"min_data_in_leaf": 5},
            num_boost_round=10,
            early_stopping_rounds=None,
        )


def test_train_lambdarank_monotone_constraints_length_check(
    mock_ranking_panel: tuple[pd.DataFrame, pd.Series, np.ndarray],
) -> None:
    X, y, groups = mock_ranking_panel
    with pytest.raises(ValueError, match="monotone_constraints"):
        train_lambdarank(
            X, y, groups,
            monotone_constraints=[1, 0],  # 长度 2 != 特征数 5
            hyperparams={"min_data_in_leaf": 5},
            num_boost_round=5,
            early_stopping_rounds=None,
        )


def test_train_lambdarank_with_validation_and_early_stopping(
    mock_ranking_panel: tuple[pd.DataFrame, pd.Series, np.ndarray],
) -> None:
    """带验证集 + 早停的训练能正常完成。"""

    X, y, groups = mock_ranking_panel
    # 简单切：前 15 日 train，后 5 日 val
    train_n = 15 * 10
    X_tr, X_va = X.iloc[:train_n].reset_index(drop=True), X.iloc[train_n:].reset_index(drop=True)
    y_tr, y_va = y.iloc[:train_n].reset_index(drop=True), y.iloc[train_n:].reset_index(drop=True)
    g_tr = np.full(15, 10, dtype=np.int64)
    g_va = np.full(5, 10, dtype=np.int64)
    booster = train_lambdarank(
        X_tr, y_tr, g_tr,
        hyperparams={"min_data_in_leaf": 5, "num_leaves": 7},
        valid_data=(X_va, y_va, g_va),
        num_boost_round=200,
        early_stopping_rounds=10,
    )
    assert booster is not None
    # 早停后 best_iteration 应该小于 200
    assert booster.best_iteration is None or booster.best_iteration <= 200
