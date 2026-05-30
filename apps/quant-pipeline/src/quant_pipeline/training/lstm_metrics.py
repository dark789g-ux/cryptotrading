# -*- coding: utf-8 -*-
"""LSTM 三分类 walk-forward 评估指标（spec 02 §5 oos_metrics 结构）。

从 lstm_walk_forward.py 抽出，避免单文件超 500 行（CLAUDE.md 硬约束）。

纯 numpy 实现（不引 sklearn / torch），便于 embargo / 结构单测在无 torch 环境跑通。
所有指标都基于三分类 {down=0, flat=1, up=2}：
  - accuracy / macro_f1 / per_class(precision/recall/f1/support)
  - confusion_matrix：行=真实类、列=预测类，顺序固定 [down, flat, up]
  - 兼容排序指标 ic / rank_ic：按 score = P(涨) − P(跌) 与「真实次日收益」算
    （让现有 OosTrendChart / Overview 不空，spec 02 §5）。真实次日收益缺失时
    退化用真实类别序数（down/flat/up → 0/1/2）做单调代理，仍能反映方向排序力。
"""

from __future__ import annotations

from typing import Any

import numpy as np

# 类别顺序（与 labels.direction_3class 一致：down=0 / flat=1 / up=2）
CLASS_ORDER: tuple[str, ...] = ("down", "flat", "up")
_N_CLASS = 3


def confusion_matrix_3class(y_true: np.ndarray, y_pred: np.ndarray) -> np.ndarray:
    """3x3 混淆矩阵。行=真实类、列=预测类，顺序 [down, flat, up]。"""

    cm = np.zeros((_N_CLASS, _N_CLASS), dtype=np.int64)
    yt = np.asarray(y_true, dtype=np.int64)
    yp = np.asarray(y_pred, dtype=np.int64)
    for t, p in zip(yt, yp):
        if 0 <= t < _N_CLASS and 0 <= p < _N_CLASS:
            cm[t, p] += 1
    return cm


def per_class_prf(cm: np.ndarray) -> dict[str, dict[str, float | int]]:
    """从混淆矩阵算逐类 precision / recall / f1 / support。"""

    out: dict[str, dict[str, float | int]] = {}
    col_sum = cm.sum(axis=0)  # 预测为各类的总数（precision 分母）
    row_sum = cm.sum(axis=1)  # 真实为各类的总数（recall 分母 = support）
    for c, name in enumerate(CLASS_ORDER):
        tp = int(cm[c, c])
        precision = tp / int(col_sum[c]) if col_sum[c] > 0 else 0.0
        recall = tp / int(row_sum[c]) if row_sum[c] > 0 else 0.0
        f1 = (
            2 * precision * recall / (precision + recall)
            if (precision + recall) > 0
            else 0.0
        )
        out[name] = {
            "precision": round(float(precision), 6),
            "recall": round(float(recall), 6),
            "f1": round(float(f1), 6),
            "support": int(row_sum[c]),
        }
    return out


def macro_f1_from_per_class(per_class: dict[str, dict[str, float | int]]) -> float:
    """三类 f1 的算术平均（macro，不按 support 加权）。"""

    f1s = [float(per_class[name]["f1"]) for name in CLASS_ORDER]
    return round(float(np.mean(f1s)), 6) if f1s else 0.0


def accuracy_from_cm(cm: np.ndarray) -> float:
    total = int(cm.sum())
    if total == 0:
        return 0.0
    return round(float(np.trace(cm)) / total, 6)


def _safe_pearson(a: np.ndarray, b: np.ndarray) -> float:
    """Pearson 相关；任一方差为 0 或样本 < 2 返回 0.0（不抛）。"""

    if a.size < 2 or b.size < 2:
        return 0.0
    if np.std(a) == 0.0 or np.std(b) == 0.0:
        return 0.0
    return float(np.corrcoef(a, b)[0, 1])


def _rankdata(x: np.ndarray) -> np.ndarray:
    """平均秩（ties → 平均），纯 numpy（避免引 scipy）。"""

    order = np.argsort(x, kind="mergesort")
    ranks = np.empty_like(order, dtype=np.float64)
    ranks[order] = np.arange(1, len(x) + 1, dtype=np.float64)
    # 处理并列：同值取平均秩
    _, inv, counts = np.unique(x, return_inverse=True, return_counts=True)
    sums = np.zeros(len(counts), dtype=np.float64)
    np.add.at(sums, inv, ranks)
    avg = sums / counts
    return avg[inv]


def score_ic_rank_ic(
    score: np.ndarray, true_ret: np.ndarray
) -> tuple[float, float]:
    """排序分 score = P(涨) − P(跌) 与真实次日收益的 IC / RankIC。

    spec 02 §5：让现有 OosTrendChart / Overview 不空。score 越大代表越看涨。
    """

    s = np.asarray(score, dtype=np.float64)
    r = np.asarray(true_ret, dtype=np.float64)
    mask = np.isfinite(s) & np.isfinite(r)
    s, r = s[mask], r[mask]
    ic = round(_safe_pearson(s, r), 6)
    if s.size >= 2:
        rank_ic = round(_safe_pearson(_rankdata(s), _rankdata(r)), 6)
    else:
        rank_ic = 0.0
    return ic, rank_ic


def build_oos_metrics(
    *,
    y_true: np.ndarray,
    y_pred: np.ndarray,
    score: np.ndarray,
    true_ret: np.ndarray,
    fold_metrics: list[dict[str, Any]],
) -> dict[str, Any]:
    """组装 spec 02 §5 的 oos_metrics JSON 结构（task=classification_3class）。"""

    cm = confusion_matrix_3class(y_true, y_pred)
    per_class = per_class_prf(cm)
    ic, rank_ic = score_ic_rank_ic(score, true_ret)
    return {
        "task": "classification_3class",
        "accuracy": accuracy_from_cm(cm),
        "macro_f1": macro_f1_from_per_class(per_class),
        "per_class": per_class,
        "confusion_matrix": cm.tolist(),
        "ic": ic,
        "rank_ic": rank_ic,
        "fold_metrics": fold_metrics,
    }


__all__ = [
    "CLASS_ORDER",
    "confusion_matrix_3class",
    "per_class_prf",
    "macro_f1_from_per_class",
    "accuracy_from_cm",
    "score_ic_rank_ic",
    "build_oos_metrics",
]
