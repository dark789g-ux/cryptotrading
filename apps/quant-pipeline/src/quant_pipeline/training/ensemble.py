"""集成预测（M3 三组对照之衍生）。

> doc/量化/05-LightGBM训练体系.md §5.8 + spec m3 §风险：
> "三组对照的'集成'建议简单平均 + 标准化排名，不要在 M3 就上 stacking（留 M4）"

实现：把多个模型的预测分**按交易日横截面**做 z-score 标准化，然后**等权平均**。
理由：不同模型分数量纲不一致（Ridge 输出 vs LambdaRank 输出），直接平均会被大量纲一边压死。

输入：scores_dict = {model_name: predictions_array}（每个 array 长度 = n_samples）
+ trade_date_array（与 scores 对齐，用于按日 cross-section 标准化）

输出：合成分数（长度 = n_samples）
"""

from __future__ import annotations

import logging
from typing import Sequence

import numpy as np
import pandas as pd

logger = logging.getLogger(__name__)


def cross_sectional_zscore(
    scores: np.ndarray,
    trade_dates: Sequence[str] | np.ndarray,
) -> np.ndarray:
    """按 trade_date 截面做 z-score 标准化。

    实现：同一日 (mean, std) → (score - mean) / std；std=0 的日子置 0。
    """

    if len(scores) != len(trade_dates):
        raise ValueError(
            f"scores ({len(scores)}) 与 trade_dates ({len(trade_dates)}) 长度不一致"
        )
    if len(scores) == 0:
        return np.zeros(0, dtype=np.float64)

    df = pd.DataFrame(
        {"score": np.asarray(scores, dtype=np.float64), "td": pd.Series(trade_dates).astype(str)}
    )
    # transform：保证输出顺序与 df 一致
    grouped = df.groupby("td", sort=False)["score"]
    means = grouped.transform("mean").to_numpy()
    # std 显式用 ddof=0（总体标准差）：截面 z-score 是对「当日全体样本」的标准化，
    # 不是从样本推断总体，用总体口径语义更正确；且避免 pandas 默认 ddof=1 在小样本日
    # （如 2 只股票）把 std 放大、z-score 被压扁。单样本日 std=0 → 下方置 0。
    stds = grouped.transform(lambda s: s.std(ddof=0)).fillna(0.0).to_numpy()
    scores_arr = df["score"].to_numpy()
    # std=0 的日子（如同日只有 1 个样本）直接置 0；用 safe-divide 避免 RuntimeWarning
    safe_stds = np.where(stds > 0, stds, 1.0)
    result = np.where(stds > 0, (scores_arr - means) / safe_stds, 0.0)
    return result.astype(np.float64)


def ensemble_average(
    scores_by_model: dict[str, np.ndarray],
    trade_dates: Sequence[str] | np.ndarray,
    weights: dict[str, float] | None = None,
) -> np.ndarray:
    """横截面标准化 + 等权（或加权）平均。

    Args:
        scores_by_model: {model_name: np.ndarray}；所有 array 必须等长
        trade_dates:     与 scores 对齐的 trade_date 序列
        weights:         可选权重；默认等权。所有 model_name 必须在 weights 中

    Returns:
        合成分数（np.ndarray）
    """

    if not scores_by_model:
        raise ValueError("scores_by_model 不能为空")
    lengths = {len(v) for v in scores_by_model.values()}
    if len(lengths) != 1:
        raise ValueError(f"所有模型的 score 长度必须一致，got {lengths}")
    n = lengths.pop()
    if len(trade_dates) != n:
        raise ValueError(
            f"trade_dates ({len(trade_dates)}) 与 scores 长度 ({n}) 不一致"
        )

    if weights is None:
        weights = {name: 1.0 for name in scores_by_model}
    else:
        missing = set(scores_by_model.keys()) - set(weights.keys())
        if missing:
            raise ValueError(f"weights 缺少模型: {missing}")

    total_weight = sum(weights[name] for name in scores_by_model)
    if total_weight <= 0:
        raise ValueError(f"weights 总和必须 > 0，got {total_weight}")

    acc = np.zeros(n, dtype=np.float64)
    for name, sc in scores_by_model.items():
        zs = cross_sectional_zscore(sc, trade_dates)
        acc += weights[name] * zs
    return acc / total_weight


__all__ = [
    "cross_sectional_zscore",
    "ensemble_average",
]
