"""A1 · lstm_metrics.score_ic_rank_ic 真实收益口径 + NaN mask 单测。

覆盖：已知输入下 IC/RankIC 数值吻合手算 Pearson/Spearman；NaN 同步剔除；
有效样本 <2 → NaN（不静默填 0 / 序数）；不破坏 build_oos_metrics 分类指标。
"""

from __future__ import annotations

import math

import numpy as np

from quant_pipeline.training.lstm_metrics import (
    build_oos_metrics,
    score_ic_rank_ic,
)


def _spearman(a: np.ndarray, b: np.ndarray) -> float:
    """参照 Spearman（scipy 无依赖时用 numpy 秩 + Pearson 验证）。"""

    from scipy.stats import spearmanr  # type: ignore

    return float(spearmanr(a, b).statistic)


def test_ic_matches_manual_pearson() -> None:
    score = np.array([0.5, -0.2, 0.1, 0.8, -0.6], dtype=np.float64)
    true_ret = np.array([0.03, -0.01, 0.005, 0.04, -0.02], dtype=np.float64)
    ic, rank_ic = score_ic_rank_ic(score, true_ret)
    expected_ic = round(float(np.corrcoef(score, true_ret)[0, 1]), 6)
    assert ic == expected_ic
    # 单调正相关 → IC、RankIC 同号且为正
    assert ic > 0 and rank_ic > 0


def test_rank_ic_matches_spearman() -> None:
    score = np.array([0.5, -0.2, 0.1, 0.8, -0.6, 0.3], dtype=np.float64)
    true_ret = np.array([0.03, -0.01, 0.005, 0.04, -0.02, 0.02], dtype=np.float64)
    _, rank_ic = score_ic_rank_ic(score, true_ret)
    assert rank_ic == round(_spearman(score, true_ret), 6)


def test_nan_pairs_dropped_in_sync() -> None:
    """true_ret 含 NaN 的位置 score 同步剔除；结果等于仅用有效对计算。"""

    score = np.array([0.5, -0.2, 0.1, 0.8, -0.6], dtype=np.float64)
    true_ret = np.array([0.03, np.nan, 0.005, np.nan, -0.02], dtype=np.float64)
    ic, rank_ic = score_ic_rank_ic(score, true_ret)

    mask = np.isfinite(true_ret)
    ic_ref, rank_ic_ref = score_ic_rank_ic(score[mask], true_ret[mask])
    assert ic == ic_ref
    assert rank_ic == rank_ic_ref


def test_fewer_than_two_valid_returns_nan() -> None:
    score = np.array([0.5, -0.2, 0.1], dtype=np.float64)
    true_ret = np.array([0.03, np.nan, np.nan], dtype=np.float64)  # 仅 1 个有效
    ic, rank_ic = score_ic_rank_ic(score, true_ret)
    assert math.isnan(ic) and math.isnan(rank_ic)


def test_all_nan_returns_nan() -> None:
    score = np.array([0.5, -0.2, 0.1], dtype=np.float64)
    true_ret = np.array([np.nan, np.nan, np.nan], dtype=np.float64)
    ic, rank_ic = score_ic_rank_ic(score, true_ret)
    assert math.isnan(ic) and math.isnan(rank_ic)


def test_zero_variance_returns_zero_not_nan() -> None:
    """有效样本 >=2 但方差为 0 → Pearson 退化为 0.0（既有 _safe_pearson 行为）。"""

    score = np.array([0.5, 0.5, 0.5, 0.5], dtype=np.float64)
    true_ret = np.array([0.01, 0.02, 0.03, 0.04], dtype=np.float64)
    ic, rank_ic = score_ic_rank_ic(score, true_ret)
    assert ic == 0.0


def test_build_oos_metrics_classification_unaffected() -> None:
    """分类主指标（accuracy / macro_f1 / 混淆矩阵）不受真实收益改动影响。"""

    y_true = np.array([0, 1, 2, 2, 0, 1], dtype=np.int64)
    y_pred = np.array([0, 1, 2, 0, 0, 1], dtype=np.int64)
    score = np.array([-0.4, 0.0, 0.5, 0.5, -0.3, 0.1], dtype=np.float64)
    true_ret = np.array([-0.02, 0.0, 0.03, np.nan, -0.01, 0.005], dtype=np.float64)
    out = build_oos_metrics(
        y_true=y_true,
        y_pred=y_pred,
        score=score,
        true_ret=true_ret,
        fold_metrics=[],
    )
    assert out["task"] == "classification_3class"
    # 5/6 预测正确（仅 index=3 的 2→0 错）
    assert out["accuracy"] == round(5 / 6, 6)
    assert out["confusion_matrix"][2] == [1, 0, 1]  # 真实=up：1 个错判 down，1 个对
    # ic 路径剔除了 1 个 NaN（index=3），仍是有效数值
    assert out["ic"] is not None
