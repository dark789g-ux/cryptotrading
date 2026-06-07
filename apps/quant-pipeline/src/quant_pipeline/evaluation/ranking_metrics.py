"""排序评估指标（M3 共享）。

> doc/量化/05-LightGBM训练体系.md §5.7 三层评估指标：
>   因子层：RankIC mean / IR（IR = mean / std）
>   组合层：见 portfolio.py
>   稳定性：见 ab_compare.py（每折指标 + IS/OOS 比）

实现：
- ndcg_at_k(scores, labels, groups, k) → 按 group 平均的 NDCG@K
  （labels 传原始连续收益率；函数内部按组转为有界整数 gain 0..4，见函数 docstring）
- ic_pearson(scores, labels) → 全样本 Pearson IC（粗略 sanity）
- rank_ic_spearman(scores, labels) → 全样本 Spearman RankIC
- daily_rank_ic(scores, labels, trade_dates) → 按日的 RankIC 序列（用于算 IR）

约束：
- 所有函数对 NaN 输入做 dropna；丢光时返回 NaN
- groups 必须满足 sum(groups) == len(scores)
"""

from __future__ import annotations

import numpy as np
import pandas as pd

# 截面分位分桶统一到 group_utils(唯一权威),保证训练侧 LambdaRank label 与评估侧
# NDCG gain 逐元素同口径(评审 05-#7;followup label_gain 崩溃修复)。ndcg_at_k 沿用
# bounded_int_gain 的默认桶数(group_utils.LABEL_GAIN_LEVELS=5)。
from quant_pipeline.training.group_utils import bounded_int_gain as _bounded_int_gain


def ndcg_at_k(
    scores: np.ndarray,
    labels: np.ndarray,
    groups: np.ndarray,
    k: int = 10,
) -> float:
    """按 group 平均的 NDCG@K。

    实现：DCG = sum((2^gain - 1) / log2(i+2))。

    gain 口径（2026-05-23 评审 05-#7）：labels 是**原始连续收益率**，直接做
    `2^label` 会指数爆炸。本函数在每个 group（交易日）内先把连续 label 转为
    **有界整数 gain**（截面分位桶 0..4），再算 DCG，保证数值稳定且与训练侧
    LambdaRank 的整数 gain 口径一致。调用方传连续 label 即可，无需自行分桶。
    """

    scores = np.asarray(scores)
    labels = np.asarray(labels)
    groups = np.asarray(groups)

    if scores.shape != labels.shape:
        raise ValueError("scores/labels 形状不一致")
    if int(groups.sum()) != len(scores):
        raise ValueError(
            f"sum(groups)={int(groups.sum())} != len(scores)={len(scores)}"
        )

    ndcgs: list[float] = []
    offset = 0
    for g in groups:
        end = offset + int(g)
        s = scores[offset:end]
        # 连续 label → 组内有界整数 gain（0..4）
        y = _bounded_int_gain(np.asarray(labels[offset:end], dtype=np.float64))
        if len(s) == 0:
            offset = end
            continue
        order = np.argsort(-s)
        gains = y[order][:k]
        ideal_order = np.argsort(-y)
        ideal_gains = y[ideal_order][:k]
        discounts = 1.0 / np.log2(np.arange(len(gains)) + 2)
        ideal_discounts = 1.0 / np.log2(np.arange(len(ideal_gains)) + 2)
        dcg = float(np.sum((np.power(2.0, gains) - 1.0) * discounts))
        idcg = float(np.sum((np.power(2.0, ideal_gains) - 1.0) * ideal_discounts))
        if idcg > 0:
            ndcgs.append(dcg / idcg)
        offset = end
    if not ndcgs:
        return float("nan")
    return float(np.mean(ndcgs))


def ic_pearson(scores: np.ndarray, labels: np.ndarray) -> float:
    """全样本 Pearson IC。"""

    s = pd.Series(scores)
    y = pd.Series(labels)
    mask = s.notna() & y.notna()
    if int(mask.sum()) < 2:
        return float("nan")
    s_v = s[mask]
    y_v = y[mask]
    if s_v.std() == 0 or y_v.std() == 0:
        return 0.0
    return float(s_v.corr(y_v))


def rank_ic_spearman(scores: np.ndarray, labels: np.ndarray) -> float:
    """全样本 Spearman RankIC。"""

    s = pd.Series(scores)
    y = pd.Series(labels)
    mask = s.notna() & y.notna()
    if int(mask.sum()) < 2:
        return float("nan")
    s_rank = s[mask].rank()
    y_rank = y[mask].rank()
    if s_rank.std() == 0 or y_rank.std() == 0:
        return 0.0
    return float(s_rank.corr(y_rank))


def daily_rank_ic(
    scores: np.ndarray,
    labels: np.ndarray,
    trade_dates: np.ndarray,
) -> pd.Series:
    """按交易日计算 RankIC，返回 index=trade_date 的 Series。

    可用于 IR = mean / std 的稳定性指标。
    """

    if not (len(scores) == len(labels) == len(trade_dates)):
        raise ValueError("scores / labels / trade_dates 三者长度必须一致")
    df = pd.DataFrame(
        {
            "score": scores,
            "label": labels,
            "td": pd.Series(trade_dates).astype(str),
        }
    )
    out: dict[str, float] = {}
    for td, sub in df.groupby("td", sort=True):
        s = sub["score"]
        y = sub["label"]
        if len(s) < 2 or s.std() == 0 or y.std() == 0:
            out[td] = float("nan")
            continue
        out[td] = float(s.rank().corr(y.rank()))
    return pd.Series(out, name="daily_rank_ic")


def ic_ir(daily_ic: pd.Series) -> float:
    """Information Ratio = mean / std。"""

    clean = daily_ic.dropna()
    if len(clean) < 2 or clean.std() == 0:
        return float("nan")
    return float(clean.mean() / clean.std())


# ---------------------------------------------------------------------------
# 对齐 spec m3 §5 命名（ic / rank_ic 短名）：
# spec 表面契约约定 `ic` / `rank_ic` 两个名字，分别对应 Pearson / Spearman；
# 这里以 alias 暴露，实现复用 ic_pearson / rank_ic_spearman，避免重复维护。
# ---------------------------------------------------------------------------

ic = ic_pearson
rank_ic = rank_ic_spearman


__all__ = [
    "ndcg_at_k",
    "ic_pearson",
    "rank_ic_spearman",
    "ic",
    "rank_ic",
    "daily_rank_ic",
    "ic_ir",
]
