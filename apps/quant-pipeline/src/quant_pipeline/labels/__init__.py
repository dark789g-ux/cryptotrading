"""labels 模块（分类后移改造，spec 2026-06-05）。

子模块：
  strategy_aware（推荐）/ fallback（fwd_ret 兜底）/
  classify（训练时离散纯函数，分类后移）/
  direction_3class（legacy 常量，解码历史 dir3 scheme 串）/ runner。

分类后移改造后：
  - compute_dir3_labels 已删除（不再产出离散标签）。
  - 分桶数学迁入 classify.py，训练时调用。
  - 历史 dir3_band / dir3_tercile 数据在 DB 原样保留。
"""

from quant_pipeline.labels.direction_3class import (
    DIR3_BAND_EPS,
    SCHEME_DIR3_BAND,
    SCHEME_DIR3_TERCILE,
)

__all__ = [
    "DIR3_BAND_EPS",
    "SCHEME_DIR3_BAND",
    "SCHEME_DIR3_TERCILE",
]
