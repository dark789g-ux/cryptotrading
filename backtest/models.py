# -*- coding: utf-8 -*-
"""
回测数据类：Position（持仓）与 TradeRecord（交易记录）。
"""

from __future__ import annotations

from dataclasses import dataclass, field


# ══════════════════════════════════════════════════════════════
#  持仓数据类
# ══════════════════════════════════════════════════════════════

@dataclass
class Position:
    symbol:            str
    entry_price:       float   # 买入价（开盘价）
    entry_time:        str     # 买入时间字符串
    entry_idx:         int     # 买入 K 线在 df 中的行下标
    shares:            float   # 持有份额（单位：币）
    allocated:         float   # 本次分配资金

    stop_price:        float   # 当前止损价
    recent_high:       float   # 阶段止盈触发价（固定）

    candle_count:      int     = 1      # 持有周期数（含买入那根，从1开始）
    max_close:         float   = 0.0    # 持有期间最高收盘价
    macd_rose:         bool    = False  # MACD 是否曾上升
    macd_was_rising:   bool    = False  # 上一根 K 线 MACD 是否在上升
    half_sold:         bool    = False  # 阶段止盈是否已触发
    half_sell_price:   float   = 0.0   # 阶段止盈成交价
    half_sell_time:    str     = ""    # 阶段止盈时间
    stop_reason:       str     = "初始止损"  # 当前止损价的设置原因
    entry_rr_ratio:    float   = 0.0   # 买入时的盈亏比
    broke_ma5:         bool    = False  # close 曾突破 MA5（高于 MA5 收盘过）
    ma5_stop_adjusted: bool    = False  # MA5 首次上升后止损已调整
    recent_high_time:  str     = ""    # 阶段高价对应的 K 线时间
    recent_low_time:   str     = ""    # 阶段低价对应的 K 线时间
    entry_reason:      str     = ""    # 买入理由（含盈亏比、高低点时间）


# ══════════════════════════════════════════════════════════════
#  交易记录
# ══════════════════════════════════════════════════════════════

@dataclass
class TradeRecord:
    symbol:         str
    entry_time:     str
    entry_price:    float
    exit_time:      str
    exit_price:     float
    shares:         float
    pnl:            float       # 绝对盈亏（USDT）
    return_pct:     float       # 收益率（%）
    exit_reason:    str         # 退出原因
    hold_candles:   int         # 持有周期数
    is_half:        bool        # 是否为阶段止盈（半仓出场）
    entry_reason:   str  = ""  # 买入理由（盈亏比文本）
