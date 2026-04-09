# -*- coding: utf-8 -*-
"""
冷却期管理：交易对平仓后的冷却期设置与检查。
"""

from __future__ import annotations

import datetime

from .config import COOLDOWN_HOURS


def set_cooldown(cooldown_until: dict[str, str], symbol: str, exit_ts: str) -> None:
    """
    为指定交易对设置冷却期。

    Args:
        cooldown_until: 冷却期字典，symbol -> 可再次入场的时间字符串
        symbol: 交易对名称
        exit_ts: 平仓时间字符串（格式：YYYY-MM-DD HH:MM:SS）
    """
    exit_dt = datetime.datetime.strptime(exit_ts, "%Y-%m-%d %H:%M:%S")
    cooldown_time = exit_dt + datetime.timedelta(hours=COOLDOWN_HOURS)
    cooldown_until[symbol] = cooldown_time.strftime("%Y-%m-%d %H:%M:%S")
