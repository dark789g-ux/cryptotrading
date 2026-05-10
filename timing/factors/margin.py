# -*- coding: utf-8 -*-
"""
因子2：融资余额
数据来源：本地 market_margin.csv（tushare macro 数据）
判断逻辑：
  - 多头：融资余额在短期均线上方，且均线趋势向上（杠杆资金看多）
  - 空头：融资余额跌破短期均线（杠杆资金撤退）
  - 破位：融资余额跌破近期N日低点，信号加强
"""

import pandas as pd
from timing.factors.base import BaseFactor, Signal, calc_ma, is_break_low
from timing.config import MA_SHORT, MA_LONG, LOW_WINDOW
from timing.data_fetcher import fetch_margin_data


class MarginFactor(BaseFactor):
    """融资余额择时因子"""

    def __init__(self, weight: float = 1.0):
        super().__init__(name="融资余额", weight=weight)

    def load_data(self) -> pd.DataFrame:
        return fetch_margin_data()

    def calculate_signal(self, df: pd.DataFrame) -> Signal:
        df = df.copy()
        # 使用融资余额 rzye
        col = "rzye"
        if col not in df.columns:
            # 兼容 tushare margin 接口返回的列名
            candidates = ["rzye", "mkt_rzye", "fin_balance"]
            for c in candidates:
                if c in df.columns:
                    col = c
                    break
            else:
                return Signal(Signal.NEUTRAL, self.name, detail="融资余额列不存在", weight=self.weight)

        df["ma_short"] = calc_ma(df, col, MA_SHORT)
        df["ma_long"] = calc_ma(df, col, MA_LONG)

        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else latest

        val = latest[col]
        ma_s = latest["ma_short"]
        ma_l = latest["ma_long"]
        ma_s_prev = prev["ma_short"]

        above_short = val > ma_s
        above_long = val > ma_l
        ma_rising = ma_s > ma_s_prev
        broke_low = is_break_low(df[col], LOW_WINDOW)
        broke_long = val < ma_l

        # 信号判断 — 破位优先级最高
        if broke_long or broke_low:
            detail = f"融资余额 {val/1e8:.1f}亿 跌破 {'长期均线' if broke_long else ''}{' / ' if broke_long and broke_low else ''}{'近期低点' if broke_low else ''}"
            return Signal(Signal.BEAR, self.name, detail=detail, weight=self.weight)

        if above_short and ma_rising:
            detail = f"融资余额 {val/1e8:.1f}亿 在 MA{MA_SHORT} 上方，杠杆资金看多"
            return Signal(Signal.BULL, self.name, detail=detail, weight=self.weight)

        if not above_short:
            detail = f"融资余额 {val/1e8:.1f}亿 跌破 MA{MA_SHORT}"
            return Signal(Signal.BEAR, self.name, detail=detail, weight=self.weight)

        detail = f"融资余额 {val/1e8:.1f}亿 位于 MA{MA_SHORT} 附近，趋势中性"
        return Signal(Signal.NEUTRAL, self.name, detail=detail, weight=self.weight)
