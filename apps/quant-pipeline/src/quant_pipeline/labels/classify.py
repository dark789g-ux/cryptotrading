"""训练时离散分类纯函数（分类后移，spec 02 §labels/classify.py）。

分类从 labels 阶段后移到训练时：feature_matrix.label 是基础连续涨跌幅，
训练入口读出连续 label 后调本模块离散成 {0=跌, 1=横盘/中, 2=涨}。

改 ε 只重跑训练步，labels/features 不需重算——这是「改 ε 不重算」的实现位置。

数学从 direction_3class._bucket_band / _bucket_tercile 迁入（与其完全一致，
但接收方为纯 Series 或 1D array + trade_date 列，不再假设已从 DB 加载离散标签）。

接口：classify(values, mode, params) → pd.Series[float] (0.0/1.0/2.0)
    values:  1D array-like（连续涨跌幅）
    mode:    'band' | 'tercile' | 'custom'
    params:  dict，随 mode 不同：
        band:    {'eps': float}  — |r| ≤ eps 判横盘
        tercile: {}              — 截面三分位（须同时传 trade_date）
        custom:  {'thresholds': [lo, hi]} — r < lo → 跌(0)，lo≤r≤hi → 横(1)，r > hi → 涨(2)
    trade_date: 仅 tercile 模式使用（截面分组键）
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

# 类别 id（与 direction_3class 一致）
_CLS_DOWN: float = 0.0    # 跌
_CLS_FLAT: float = 1.0    # 横盘
_CLS_UP: float = 2.0      # 涨

_VALID_MODES: frozenset[str] = frozenset({"band", "tercile", "custom"})


def _bucket_band(r: pd.Series, eps: float) -> pd.Series:
    """固定阈值带分桶（数学与 direction_3class._bucket_band 完全一致）。

    r > +ε → 涨(2)，|r| ≤ ε → 横盘(1)，r < −ε → 跌(0)。
    边界 r == ±ε 落入横盘（|r| ≤ ε 闭区间）。
    """

    value = pd.Series(_CLS_FLAT, index=r.index, dtype=float)
    value[r > eps] = _CLS_UP
    value[r < -eps] = _CLS_DOWN
    return value


def _bucket_tercile(r: pd.Series, trade_date: pd.Series) -> pd.Series:
    """截面三分位分桶（数学与 direction_3class._bucket_tercile 完全一致）。

    对每个 trade_date 截面内按 r 稳定排序，
    前 1/3 → 跌(0)，中 1/3 → 横盘(1)，后 1/3 → 涨(2)。

    用稳定排序（kind="stable"）保证并列值切分确定；类近似均衡。
    截面内仅 1~2 行时按相同三分位边界落桶（不强行凑满三类）。
    """

    value = pd.Series(_CLS_FLAT, index=r.index, dtype=float)
    for _, idx in r.groupby(trade_date, sort=False).groups.items():
        sub = r.loc[idx]
        n = len(sub)
        order = sub.sort_values(kind="stable")
        rank = pd.Series(np.arange(n), index=order.index)
        lo = n // 3
        hi = n - n // 3
        cls = pd.Series(_CLS_FLAT, index=order.index, dtype=float)
        cls[rank < lo] = _CLS_DOWN
        cls[rank >= hi] = _CLS_UP
        value.loc[cls.index] = cls
    return value


def _bucket_custom(r: pd.Series, thresholds: list[float]) -> pd.Series:
    """自定义阈值分桶。

    thresholds = [lo, hi]：r < lo → 跌(0)，lo ≤ r ≤ hi → 横盘(1)，r > hi → 涨(2)。
    lo 必须 < hi；两者均可为负/零/正（如 [-0.01, 0.01]）。
    """

    if len(thresholds) != 2:
        raise ValueError(
            f"custom mode requires thresholds=[lo, hi] (2 elements), got {thresholds!r}"
        )
    lo, hi = float(thresholds[0]), float(thresholds[1])
    if lo >= hi:
        raise ValueError(
            f"custom thresholds: lo < hi required, got lo={lo!r} hi={hi!r}"
        )
    value = pd.Series(_CLS_FLAT, index=r.index, dtype=float)
    value[r > hi] = _CLS_UP
    value[r < lo] = _CLS_DOWN
    return value


def classify(
    values: Any,
    mode: str,
    params: dict[str, Any],
    *,
    trade_date: Any | None = None,
) -> pd.Series:
    """连续涨跌幅 → 离散类别 {0=跌, 1=横盘, 2=涨}（训练时调用）。

    Args:
        values:     1D array-like，连续涨跌幅。可含 NaN（NaN 行保留 NaN 类别）。
        mode:       'band' | 'tercile' | 'custom'
        params:     dict。
            band:    {'eps': float}   — |r| ≤ eps 判横盘（eps > 0）
            tercile: {}               — 截面三分位（须传 trade_date）
            custom:  {'thresholds': [lo, hi]}
        trade_date: tercile 模式的截面分组键（1D array-like，与 values 等长）。
                    其它模式忽略。

    Returns:
        pd.Series[float]，值域 {0.0, 1.0, 2.0, NaN}（NaN 处 values 为 NaN）。

    Raises:
        ValueError: mode 非法 / params 缺参 / 范围越界 / tercile 未传 trade_date。
    """

    if mode not in _VALID_MODES:
        raise ValueError(
            f"classify: mode must be one of {sorted(_VALID_MODES)}, got {mode!r}"
        )

    r = pd.Series(values, dtype=float)
    nan_mask = r.isna()

    if mode == "band":
        eps_raw = params.get("eps")
        if eps_raw is None:
            raise ValueError("classify band mode requires params={'eps': float}")
        eps = float(eps_raw)
        if eps <= 0:
            raise ValueError(f"classify band eps must be > 0, got {eps!r}")
        result = _bucket_band(r.fillna(0.0), eps)

    elif mode == "tercile":
        if trade_date is None:
            raise ValueError(
                "classify tercile mode requires trade_date argument (1D array-like)"
            )
        td = pd.Series(trade_date)
        if len(td) != len(r):
            raise ValueError(
                f"classify: trade_date length {len(td)} != values length {len(r)}"
            )
        td.index = r.index
        result = _bucket_tercile(r.fillna(0.0), td)

    else:  # custom
        thresholds = params.get("thresholds")
        if thresholds is None:
            raise ValueError(
                "classify custom mode requires params={'thresholds': [lo, hi]}"
            )
        result = _bucket_custom(r.fillna(0.0), list(thresholds))

    # NaN label 行回写 NaN（不产出假类别）
    result[nan_mask] = float("nan")
    return result


__all__ = [
    "classify",
    "_bucket_band",
    "_bucket_tercile",
    "_bucket_custom",
    "_CLS_DOWN",
    "_CLS_FLAT",
    "_CLS_UP",
]
