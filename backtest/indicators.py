# -*- coding: utf-8 -*-
"""
近期高低价计算工具函数，供入场信号扫描与止损/止盈基准使用。
"""

from __future__ import annotations

import pandas as pd

from .config import LOOKBACK_BUFFER, RECENT_WINDOW


def calc_recent_low(df: pd.DataFrame, entry_idx: int) -> tuple[float, str]:
    """
    买入点 entry_idx 的近期低价（止损基准）。
    返回 (price, open_time)。
    - 以买入日前 RECENT_WINDOW 根 K 线的最低价作为初始阶段低点
    - 向前遍历（上限 LOOKBACK_BUFFER 根）：若该 K 线最低价 <= 当前阶段低点，
      则更新阶段低点并继续；否则停止
    """
    win_end   = entry_idx
    win_start = max(0, entry_idx - RECENT_WINDOW)
    if win_start >= win_end:
        return float(df.at[entry_idx, "low"]), str(df.at[entry_idx, "open_time"])

    sub      = df["low"].iloc[win_start:win_end]
    recent   = float(sub.min())
    best_idx = int(sub.idxmin())

    limit = max(0, entry_idx - LOOKBACK_BUFFER)
    idx   = win_start - 1
    while idx >= limit:
        v = float(df.at[idx, "low"])
        if v <= recent:
            recent   = v
            best_idx = idx
            idx -= 1
        else:
            break

    return recent, str(df.at[best_idx, "open_time"])


def calc_recent_high(df: pd.DataFrame, entry_idx: int) -> tuple[float, str]:
    """
    买入点 entry_idx 的近期高价（阶段止盈触发价）。
    返回 (price, open_time)。
    - 以买入日前 RECENT_WINDOW 根 K 线的最高价作为初始阶段高点
    - 向前遍历（上限 LOOKBACK_BUFFER 根）：若该 K 线最高价 >= 当前阶段高点，
      则更新阶段高点并继续；否则停止
    """
    win_end   = entry_idx
    win_start = max(0, entry_idx - RECENT_WINDOW)
    if win_start >= win_end:
        return float(df.at[entry_idx, "high"]), str(df.at[entry_idx, "open_time"])

    sub      = df["high"].iloc[win_start:win_end]
    recent   = float(sub.max())
    best_idx = int(sub.idxmax())

    limit = max(0, entry_idx - LOOKBACK_BUFFER)
    idx   = win_start - 1
    while idx >= limit:
        v = float(df.at[idx, "high"])
        if v >= recent:
            recent   = v
            best_idx = idx
            idx -= 1
        else:
            break

    return recent, str(df.at[best_idx, "open_time"])
