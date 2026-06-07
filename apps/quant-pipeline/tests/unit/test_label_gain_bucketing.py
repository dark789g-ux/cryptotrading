"""label→gain 截面分桶单测(followup: lambdarank label_gain 崩溃修复)。

核心契约:
  - 训练侧 LambdaRank label 与评估侧 NDCG gain **同口径**(都走 group_utils.bounded_int_gain)。
  - 连续(含负、含极端)label 经截面分桶后落在 0..LABEL_GAIN_LEVELS-1,
    远小于 LightGBM 默认 label_gain 表(0..30),稠密市场(数千票/天)不再崩溃。

回归两条历史崩溃:
  崩A: 截面 rank 0..n-1 → "Label N is not less than number of label mappings (31)"
  崩B: 原始连续含负浮点直喂 → "label should be int type"
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from quant_pipeline.evaluation.ranking_metrics import _bounded_int_gain
from quant_pipeline.training.group_utils import (
    LABEL_GAIN_LEVELS,
    bounded_int_gain,
    build_groups,
    label_to_bucketed_gain,
)
from quant_pipeline.training.lightgbm_lambdarank import train_lambdarank


def test_label_gain_levels_is_five() -> None:
    """桶数锚定 5,与 ranking_metrics NDCG 口径一致(评审 05-#7)。"""
    assert LABEL_GAIN_LEVELS == 5


def test_bounded_int_gain_single_source_of_truth() -> None:
    """ranking_metrics._bounded_int_gain 必须委托 group_utils.bounded_int_gain,
    两侧逐元素一致——否则训练 label 与评估 gain 口径会再次分裂。"""
    rng = np.random.default_rng(0)
    y = rng.normal(size=137)
    a = bounded_int_gain(y, LABEL_GAIN_LEVELS)
    b = _bounded_int_gain(y, LABEL_GAIN_LEVELS)
    assert np.array_equal(a, b)


def test_bounded_int_gain_caps_within_table() -> None:
    """稠密一组(5000 连续值含负+极端) → gain ∈ [0, LABEL_GAIN_LEVELS-1],远 < 31。"""
    rng = np.random.default_rng(1)
    y = np.concatenate([rng.normal(size=4998) * 0.05, np.array([-0.97, 11.15])])
    g = bounded_int_gain(y, LABEL_GAIN_LEVELS)
    assert g.min() == 0.0
    assert g.max() == float(LABEL_GAIN_LEVELS - 1)
    assert len(g) == len(y)


def test_bounded_int_gain_degenerate_sizes() -> None:
    assert len(bounded_int_gain(np.array([]), LABEL_GAIN_LEVELS)) == 0
    assert np.array_equal(bounded_int_gain(np.array([3.14]), LABEL_GAIN_LEVELS), [0.0])


def _panel(n_dates: int, n_codes: int, seed: int = 7) -> tuple[pd.DataFrame, pd.Series]:
    rng = np.random.default_rng(seed)
    meta: list[dict] = []
    ys: list[float] = []
    for d in range(n_dates):
        td = f"2026{1 + d // 28:02d}{1 + d % 28:02d}"
        for i in range(n_codes):
            meta.append({"trade_date": td, "ts_code": f"{i:06d}.SZ"})
            ys.append(float(rng.normal() * 0.05))
    return pd.DataFrame(meta), pd.Series(ys, name="label")


def test_label_to_bucketed_gain_matches_metric_per_group() -> None:
    """逐 trade_date 截面分桶结果,必须等于评估侧对同组逐个 _bounded_int_gain。"""
    df_meta, y = _panel(n_dates=6, n_codes=53)
    out = label_to_bucketed_gain(df_meta, y, LABEL_GAIN_LEVELS)
    # 索引与 dtype 契约
    assert list(out.index) == list(y.index)
    assert out.dtype.kind in ("i", "u")
    assert out.min() >= 0 and out.max() <= LABEL_GAIN_LEVELS - 1
    # 与评估侧逐组比对
    td = df_meta["trade_date"].astype(str).to_numpy()
    expected = np.empty(len(y), dtype=np.int64)
    for day in pd.unique(td):
        idx = np.where(td == day)[0]
        expected[idx] = _bounded_int_gain(y.to_numpy()[idx], LABEL_GAIN_LEVELS).astype(np.int64)
    assert np.array_equal(out.to_numpy(), expected)


def test_label_to_bucketed_gain_preserves_nonconsecutive_index() -> None:
    """y 带非连续 index(上游 dropna/iloc 后常见)时,返回 index 不被重排。"""
    df_meta, y = _panel(n_dates=2, n_codes=10)
    y.index = pd.RangeIndex(start=100, stop=100 + len(y))
    out = label_to_bucketed_gain(df_meta, y, LABEL_GAIN_LEVELS)
    assert list(out.index) == list(y.index)


def test_train_lambdarank_dense_continuous_with_negatives_no_crash() -> None:
    """回归崩A+崩B:稠密(500票/天×2天)连续含负 label,经分桶后 train_lambdarank 成功。

    - 崩A:旧 0..n-1 rank 会到 ~499 > 30 → Label not less than 31。
    - 崩B:原始连续含负 -0.x 直喂 → label should be int type。
    分桶后 gain ≤ 4,两崩均消除。
    """
    df_meta, y = _panel(n_dates=2, n_codes=500, seed=42)
    assert (y < 0).sum() > 0  # 确含负
    df_meta = df_meta.sort_values(["trade_date", "ts_code"]).reset_index(drop=True)
    y = y.reset_index(drop=True)
    rng = np.random.default_rng(3)
    X = pd.DataFrame(
        {f"f{j}": rng.normal(size=len(y)) for j in range(4)}
    )
    groups = build_groups(df_meta)
    y_gain = label_to_bucketed_gain(df_meta, y, LABEL_GAIN_LEVELS)
    booster = train_lambdarank(
        X, y_gain, groups, num_boost_round=5, early_stopping_rounds=None
    )
    pred = np.asarray(booster.predict(X.values), dtype=np.float64)
    assert len(pred) == len(y)
