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


__all__ = ["build_groups", "flatten_features"]
