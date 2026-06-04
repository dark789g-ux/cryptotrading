"""三分类方向标签 — legacy 解码常量（spec 02 §向后兼容）。

分类后移改造（spec 2026-06-05）：
  - labels 阶段不再离散 r → 0/1/2；连续 r 由 fallback.compute_fwd_5d_ret(horizon=1)
    计算并写入 factors.labels（scheme='fwd_ret_h1'）。
  - 分桶数学（_bucket_band / _bucket_tercile）已迁移到 labels/classify.py，
    训练时由 classify() 调用。
  - 本模块保留 SCHEME_DIR3_BAND / SCHEME_DIR3_TERCILE / DIR3_BAND_EPS 常量，
    供识别库中历史 dir3 scheme 串（只读，不再产出新离散标签）。
  - compute_dir3_labels 直接删除，不留死分支（spec §向后兼容：不靠重跑老代码路径）。

历史 dir3_band / dir3_tercile 数据库里原样保留，
老 model_run 靠库里已物化的历史特征矩阵复现。
"""

from __future__ import annotations

from typing import Final

from quant_pipeline.labels.dir3_scheme import LEGACY_EPS

SCHEME_DIR3_BAND: Final[str] = "dir3_band"
SCHEME_DIR3_TERCILE: Final[str] = "dir3_tercile"
# legacy 默认 ε（识别历史 scheme 串用，不再产出新标签）
DIR3_BAND_EPS: Final[float] = LEGACY_EPS
# 次日方向：持有 1 日语义（向后兼容常量，供已有测试引用）
DIR3_HOLD_DAYS: Final[int] = 1


__all__ = [
    "SCHEME_DIR3_BAND",
    "SCHEME_DIR3_TERCILE",
    "DIR3_BAND_EPS",
    "DIR3_HOLD_DAYS",
]
