"""labels 模块占位（M2 起实装）。

子模块：strategy_aware（推荐）/ fallback（fwd_5d_ret 兜底）/
direction_3class（LSTM 三分类方向）/ runner。
"""

from quant_pipeline.labels.direction_3class import (
    DIR3_BAND_EPS,
    SCHEME_DIR3_BAND,
    SCHEME_DIR3_TERCILE,
    compute_dir3_labels,
)

__all__ = [
    "DIR3_BAND_EPS",
    "SCHEME_DIR3_BAND",
    "SCHEME_DIR3_TERCILE",
    "compute_dir3_labels",
]
