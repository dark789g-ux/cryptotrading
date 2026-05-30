# -*- coding: utf-8 -*-
"""LSTM 三分类 walk-forward 评估指标（spec 02 §5 oos_metrics 结构）。

2026-05-30（lgb-multiclass spec 03 §评估）：通用三分类纯函数已抽到
``training.classification_metrics`` 供 lstm 与 lgb-multiclass 共用。本模块改为
从共享模块**重导出**，保留原有公开名以兼容既有 import / 单测，零行为变化。
"""

from __future__ import annotations

import numpy as np  # noqa: F401 — 公开 API 为 numpy 数组指标；保留 import 明示纯 numpy 依赖（无 torch）

from quant_pipeline.training.classification_metrics import (
    CLASS_ORDER,
    accuracy_from_cm,
    build_oos_metrics,
    confusion_matrix_3class,
    macro_f1_from_per_class,
    per_class_prf,
    score_ic_rank_ic,
)

# 私有数值工具也重导出（个别单测 / 内部模块可能直接引用）。
from quant_pipeline.training.classification_metrics import (  # noqa: F401
    _N_CLASS,
    _rankdata,
    _safe_pearson,
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
