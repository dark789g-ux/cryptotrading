"""训练 / 评估共享工具：query group 构建 + features 展平。

2026-05-23 起（04-training 评审 #14）：原本 `runner.py` / `tuning.py` /
`walk_forward_runner.py` / `ab_compare.py` 各有一份几乎相同的
`_build_groups` / `_flatten_features` 实现，且已出现漂移。统一抽到本模块。
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def build_groups(df: pd.DataFrame) -> np.ndarray:
    """以 trade_date 为 query group；返回每日样本数数组（顺序与 df 一致）。

    LambdaRank 要求样本按 query group 连续排列，`group_sizes` 元素为各 group 大小。
    调用方需保证 df 已按 (trade_date, ...) 排序。
    """

    return df.groupby("trade_date", sort=False).size().to_numpy().astype(np.int64)


# LambdaRank 训练 label / NDCG 评估 gain 的截面分位桶数。
# 桶数锚定 5(gain ∈ {0,1,2,3,4}):`2^gain - 1` 上界 = 15,落在 LightGBM 默认
# label_gain 表(0..30)内,稠密市场(数千票/天)不再撞 "Label N not less than 31"。
# 训练侧与评估侧(ranking_metrics)必须共用本常量与 bounded_int_gain,避免口径分裂。
# 经验值:2026-06-07 在 fs_60bc257fb173 全量重训实测 5/10/30 桶,lambdarank OOS
# rank_ic(连续标签算、跨桶可比)随桶数单调变差:5→+0.046、10→−0.064、30→−0.091
# (指数 gain 下高桶过度主导、放大极端收益噪声)。故 5 桶为最优,勿轻易调大。
LABEL_GAIN_LEVELS = 5


def bounded_int_gain(y: np.ndarray, n_levels: int = LABEL_GAIN_LEVELS) -> np.ndarray:
    """单 query group(同一交易日)内:连续 label → 有界整数 gain(0..n_levels-1)。

    组内按 label 升序名次均匀分桶。结果是**该组每个元素的 gain**(与输入同序、同长)。
    评审 05-#7:连续收益率直接做 `2^label - 1` 会指数爆炸(label 可达 +11),NDCG
    完全被极端值主导;分桶后 `2^gain - 1` 有界(n_levels=5 → 最大 15),数值稳定。

    **唯一权威实现**:训练侧 LambdaRank label 与评估侧 NDCG gain 都经此函数,
    保证两侧逐元素同口径(见 ranking_metrics._bounded_int_gain / label_to_bucketed_gain)。
    """

    m = len(y)
    if m == 0:
        return np.zeros(0, dtype=np.float64)
    if m == 1:
        return np.zeros(1, dtype=np.float64)
    # 0..m-1 升序名次(stable 打破 tie,与训练侧历史 rank(method='first') 同语义)
    order = np.argsort(np.argsort(y, kind="stable"), kind="stable")
    bins = (order * n_levels // m).astype(np.float64)
    return np.clip(bins, 0.0, float(n_levels - 1))


def label_to_bucketed_gain(
    df_meta: pd.DataFrame, y: pd.Series, n_levels: int = LABEL_GAIN_LEVELS
) -> pd.Series:
    """把连续 label 按 trade_date 截面分桶为整数 gain,给 LambdaRank 训练当 label。

    逐 trade_date 组调用 bounded_int_gain → 与 ranking_metrics.ndcg_at_k 的 gain 口径
    逐元素一致(同一函数)。替代历史三份重复的 `_label_to_cross_sectional_rank`
    (0..n-1 截面 rank,稠密市场 rank 上千会撞 LightGBM label_gain 31 项上限)。

    Args:
        df_meta: 含 `trade_date` 列,行序与 y 对齐。
        y: 连续 label(可含负、含极端值)。
        n_levels: 桶数,默认 LABEL_GAIN_LEVELS。

    Returns:
        与 y 同 index 的整数 Series,值域 0..n_levels-1。
    """

    td = df_meta["trade_date"].astype(str).to_numpy()
    yv = np.asarray(y.to_numpy(), dtype=np.float64)
    out = np.zeros(len(yv), dtype=np.int64)
    work = pd.DataFrame({"td": td, "_pos": np.arange(len(yv)), "y": yv})
    for _, grp in work.groupby("td", sort=False):
        gains = bounded_int_gain(grp["y"].to_numpy(), n_levels).astype(np.int64)
        out[grp["_pos"].to_numpy()] = gains
    return pd.Series(out, index=y.index)


def flatten_features(df: pd.DataFrame) -> tuple[pd.DataFrame, list[str]]:
    """把 features:dict 列展平为多列。

    Returns:
        (X, feature_keys)；feature_keys 升序排序，保证列顺序稳定。
    """

    if df.empty:
        return pd.DataFrame(), []
    feature_keys: list[str] = sorted(
        {k for row in df["features"] if isinstance(row, dict) for k in row.keys()}
    )
    if not feature_keys:
        raise ValueError("feature_matrix.features 为空，没有可训练的列")
    records = [
        {k: row.get(k, np.nan) if isinstance(row, dict) else np.nan for k in feature_keys}
        for row in df["features"]
    ]
    X = pd.DataFrame.from_records(records, columns=feature_keys)
    return X, feature_keys


__all__ = [
    "LABEL_GAIN_LEVELS",
    "bounded_int_gain",
    "build_groups",
    "flatten_features",
    "label_to_bucketed_gain",
]
