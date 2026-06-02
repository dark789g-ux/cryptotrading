"""lgb-multiclass 三分类评估（spec 03 §评估）。

复用 ``training.classification_metrics`` 的通用三分类纯函数（混淆矩阵 / per-class
PRF / macro-F1 / accuracy / ic-rank_ic），与 LSTM 完全同构，便于前端统一展示。

本模块只是薄封装 + 显式 re-export，保证 lgb-multiclass walk-forward 与 lstm 调用
同一份 ``build_oos_metrics``，输出结构一致（task=classification_3class）。
"""

from __future__ import annotations

from quant_pipeline.training.classification_metrics import (
    CLASS_ORDER,
    accuracy_from_cm,
    build_oos_metrics,
    confusion_matrix_3class,
    macro_f1_from_per_class,
    per_class_prf,
    score_ic_rank_ic,
)

__all__ = [
    "CLASS_ORDER",
    "confusion_matrix_3class",
    "per_class_prf",
    "macro_f1_from_per_class",
    "accuracy_from_cm",
    "score_ic_rank_ic",
    "build_oos_metrics",
]
