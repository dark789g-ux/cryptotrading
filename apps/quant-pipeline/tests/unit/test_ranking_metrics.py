"""Ranking metrics 单测（M3 Part I）。

覆盖：
  - ndcg_at_k 完美排序 = 1.0
  - ndcg_at_k 完全反向 < 1.0
  - ic_pearson / rank_ic_spearman 在已知线性关系上接近 1
  - daily_rank_ic 按日返回；ic_ir 计算
  - groups 和 scores 长度不匹配抛错
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest

from quant_pipeline.evaluation.ranking_metrics import (
    daily_rank_ic,
    ic_ir,
    ic_pearson,
    ndcg_at_k,
    rank_ic_spearman,
)


def test_ndcg_perfect_order_is_one() -> None:
    scores = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
    labels = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
    groups = np.array([5])
    assert ndcg_at_k(scores, labels, groups, k=5) == pytest.approx(1.0)


def test_ndcg_reverse_order_less_than_perfect() -> None:
    scores = np.array([1.0, 2.0, 3.0, 4.0, 5.0])  # 反向
    labels = np.array([5.0, 4.0, 3.0, 2.0, 1.0])
    groups = np.array([5])
    v = ndcg_at_k(scores, labels, groups, k=5)
    assert 0.0 <= v < 1.0


def test_ndcg_groups_sum_mismatch() -> None:
    with pytest.raises(ValueError, match="sum"):
        ndcg_at_k(np.array([1.0, 2.0]), np.array([1.0, 2.0]), np.array([3]))


def test_ic_pearson_perfect_linear() -> None:
    s = np.arange(100, dtype=np.float64)
    y = 2 * s + 3
    assert ic_pearson(s, y) == pytest.approx(1.0)


def test_rank_ic_spearman_monotonic() -> None:
    s = np.arange(100, dtype=np.float64)
    y = np.exp(s / 10.0)  # 单调 → RankIC=1
    assert rank_ic_spearman(s, y) == pytest.approx(1.0)


def test_daily_rank_ic_and_ir() -> None:
    rng = np.random.default_rng(42)
    rows = []
    for d in range(10):
        td = f"2026010{d}"
        for i in range(20):
            x = rng.normal()
            rows.append({"td": td, "score": x, "label": x + rng.normal(scale=0.1)})
    df = pd.DataFrame(rows)
    s = df["score"].to_numpy()
    y = df["label"].to_numpy()
    td_arr = df["td"].to_numpy()

    daily = daily_rank_ic(s, y, td_arr)
    assert len(daily) == 10
    # IR 计算
    ir = ic_ir(daily)
    assert np.isfinite(ir)


def test_ic_pearson_handles_nan() -> None:
    s = np.array([1.0, np.nan, 3.0, 4.0])
    y = np.array([2.0, 2.0, 6.0, 8.0])
    v = ic_pearson(s, y)
    assert np.isfinite(v)
