# -*- coding: utf-8 -*-
"""feature_set_id 覆盖层哈希（spec 02 §feature-set-id 哈希，方案 A）。

**方案 A：仅显式非默认参数入哈希**。把哈希输入分两层：

1. **基础层**（现状不变）：``factor_version`` / ``label_scheme`` / ``new_listing_min_days`` /
   ``neutralize_cols`` / ``robust_z`` / ``factor_ids``，由 ``builder.build_feature_set_id``
   原样计算，得到基础 ``feature_set_id``（形如 ``fs_<sha12>``）。
2. **覆盖层**（本模块新增）：仅当用户**显式传入且值 != 该参数默认值**时，才把该参数
   追加进覆盖串；等于默认值或未传 → 不追加。

由此数学保证（回归红线）：

    旧任务 / 全用默认 → 覆盖层为空 → 最终 id == 基础 id == 改动前 id（历史缓存命中）
    用户改了某参数(非默认) → 覆盖层非空 → 最终 id 不同 → 不会误命中旧缓存

「默认值」单一真理源取自 builder / labels 模块的现有常量（与覆盖层比对的基准必须
取自同一常量，避免两处默认漂移）。

> 注意：``neutralize_cols`` / ``robust_z`` 已被基础层（builder.build_feature_set_id）
> 纳入哈希，本覆盖层**不重复**纳入它们——否则同一份非默认 neutralize_cols 会同时
> 改变基础层与覆盖层、产生与设计意图不符的双重影响。本模块只负责基础层尚未覆盖的
> 新参数：``factor_clip_sigma`` / ``label_winsorize`` / ``fwd_horizon_days`` /
> ``max_hold_days``，且按「对当前 label_scheme 实际生效」裁剪。
"""

from __future__ import annotations

import hashlib
import json
from typing import Any

from quant_pipeline.features.builder import FACTOR_CLIP_SIGMA
from quant_pipeline.labels.fallback import FWD_HORIZON_DAYS as DEFAULT_FWD_HORIZON_DAYS
from quant_pipeline.labels.strategy_aware import (
    WINSORIZE_HI as DEFAULT_WINSORIZE_HI,
)
from quant_pipeline.labels.strategy_aware import (
    WINSORIZE_LO as DEFAULT_WINSORIZE_LO,
)

# strategy-aware 的默认最大持仓交易日（单一真理源：strategy.exit_rules.MAX_HOLD_DAYS）。
from quant_pipeline.strategy.exit_rules import MAX_HOLD_DAYS as DEFAULT_MAX_HOLD_DAYS

# float 规范化精度：与覆盖层比对/序列化统一 round，避免 3.0 vs 3.0000001 漂移。
_FLOAT_NDIGITS = 6


def _norm_float(x: float) -> float:
    return round(float(x), _FLOAT_NDIGITS)


def build_overlay(
    *,
    label_scheme: str,
    factor_clip_sigma: float | None = None,
    label_winsorize: tuple[float, float] | None = None,
    fwd_horizon_days: int | None = None,
    max_hold_days: int | None = None,
) -> dict[str, Any]:
    """构造「非默认参数覆盖层」字典（已规范化）。

    仅把「显式传入 且 值 != 默认值 且 对当前 label_scheme 实际生效」的参数纳入。
    返回空 dict 表示全默认 → 最终 id 退回基础 id（回归红线）。

    生效裁剪：
      - ``label_winsorize`` 仅对连续收益标签（strategy-aware / fwd_5d_ret）生效；
        dir3 系标签 value 是类别 id（0/1/2），winsorize 无意义 → 不纳入。
      - ``fwd_horizon_days`` 仅对 ``fwd_5d_ret`` 生效。
      - ``max_hold_days`` 仅对 ``strategy-aware`` 生效。
      - ``factor_clip_sigma`` 作用于因子矩阵，与 label_scheme 无关 → 始终可纳入。
    """

    overlay: dict[str, Any] = {}

    # factor_clip_sigma：作用于因子，与 scheme 无关。
    if factor_clip_sigma is not None:
        if _norm_float(factor_clip_sigma) != _norm_float(FACTOR_CLIP_SIGMA):
            overlay["factor_clip_sigma"] = _norm_float(factor_clip_sigma)

    # label_winsorize：仅连续收益标签生效。
    if label_winsorize is not None and label_scheme in ("strategy-aware", "fwd_5d_ret"):
        lo, hi = _norm_float(label_winsorize[0]), _norm_float(label_winsorize[1])
        if (lo, hi) != (_norm_float(DEFAULT_WINSORIZE_LO), _norm_float(DEFAULT_WINSORIZE_HI)):
            overlay["label_winsorize"] = [lo, hi]

    # fwd_horizon_days：仅 fwd_5d_ret 生效。
    if fwd_horizon_days is not None and label_scheme == "fwd_5d_ret":
        if int(fwd_horizon_days) != int(DEFAULT_FWD_HORIZON_DAYS):
            overlay["fwd_horizon_days"] = int(fwd_horizon_days)

    # max_hold_days：仅 strategy-aware 生效。
    if max_hold_days is not None and label_scheme == "strategy-aware":
        if int(max_hold_days) != int(DEFAULT_MAX_HOLD_DAYS):
            overlay["max_hold_days"] = int(max_hold_days)

    return overlay


def overlay_canonical_str(overlay: dict[str, Any]) -> str:
    """覆盖层规范化串（按 key 排序、float 定精度、稳定字面）。空覆盖 → 空串。"""

    if not overlay:
        return ""
    return json.dumps(overlay, sort_keys=True, ensure_ascii=False, separators=(",", ":"))


def apply_overlay_to_feature_set_id(base_id: str, overlay: dict[str, Any]) -> str:
    """把覆盖层折进基础 feature_set_id。

    - 覆盖层为空 → 原样返回 base_id（回归红线：全默认 == 改动前 id）。
    - 覆盖层非空 → 返回 ``fs_<sha12( base_id + '|' + overlay_canonical_str )>``，
      与基础 id 在同一命名空间（``fs_`` 前缀 + 12 位 sha），但确定性地不同。
    """

    canonical = overlay_canonical_str(overlay)
    if not canonical:
        return base_id
    payload = f"{base_id}|{canonical}"
    sha = hashlib.sha256(payload.encode("utf-8")).hexdigest()[:12]
    return f"fs_{sha}"


__all__ = [
    "build_overlay",
    "overlay_canonical_str",
    "apply_overlay_to_feature_set_id",
]
