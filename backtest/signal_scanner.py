# -*- coding: utf-8 -*-
"""
信号扫描器：入场信号扫描与盈亏比计算。
"""

from __future__ import annotations

import pandas as pd

from .config import (
    KDJ_K_MAX,
    KDJ_D_MAX,
    KDJ_J_MAX,
    MAX_INIT_LOSS,
    MIN_RISK_REWARD_RATIO,
)
from .indicators import calc_recent_high, calc_recent_low


def scan_signals(
    data: dict[str, pd.DataFrame],
    ts: str,
    ts_to_idx: dict[str, dict[str, int]],
    held_symbols: set[str],
    cooldown_until: dict[str, str],
) -> list[tuple[str, float]]:
    """
    扫描当前时间步收盘后的入场信号：
        close > MA60 AND MA30 > MA60 AND MA60 > MA120 AND close > MA240 AND KDJ.J < 10
    以收盘价作为买入价估算，计算盈亏比：
        盈亏比 = (近期高点 - 买入价) / (买入价 - 近期低点)
    返回按盈亏比降序排列的 (symbol, 盈亏比) 列表。
    """
    candidates: list[tuple[str, float]] = []

    for symbol, df in data.items():
        if symbol in held_symbols:
            continue
        # 检查冷却期：如果当前时间早于冷却结束时间，跳过
        if ts < cooldown_until.get(symbol, ""):
            continue
        idx_map = ts_to_idx.get(symbol)
        if idx_map is None:
            continue
        idx = idx_map.get(ts)
        if idx is None:
            continue

        row = df.iloc[idx]
        close = float(row["close"])
        ma30 = float(row["MA30"])
        ma60 = float(row["MA60"])
        ma120 = float(row["MA120"])
        ma240 = float(row["MA240"])
        kdj_k = float(row["KDJ.K"])
        kdj_d = float(row["KDJ.D"])
        kdj_j = float(row["KDJ.J"])

        # 检查基础入场条件
        if not (close > ma60 and ma30 > ma60 and ma60 > ma120
                and close > ma240):
            continue

        # KDJ 超卖条件：K、D、J 必须同时小于各自阈值
        if not (kdj_k < KDJ_K_MAX and kdj_d < KDJ_D_MAX and kdj_j < KDJ_J_MAX):
            continue

        # 入场条件通过后才计算近期低点
        recent_low, _ = calc_recent_low(df, idx + 1)

        # 新增规则：1 - (阶段低点/收盘价) < MAX_INIT_LOSS
        init_loss = 1 - (recent_low / close)
        if init_loss >= MAX_INIT_LOSS:
            continue

        buy_price = close
        # 传入 idx+1 使窗口为 [idx-4, idx]，包含信号K线本身
        recent_high, _ = calc_recent_high(df, idx + 1)
        risk = buy_price - recent_low
        reward = recent_high - buy_price
        rr_ratio = reward / risk if risk > 0 else 0.0

        # 新增入场条件：盈亏比必须大于最小盈亏比
        if rr_ratio <= MIN_RISK_REWARD_RATIO:
            continue

        candidates.append((symbol, rr_ratio))

    candidates.sort(key=lambda x: x[1], reverse=True)
    return candidates
