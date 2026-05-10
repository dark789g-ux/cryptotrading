# -*- coding: utf-8 -*-
"""
因子1：A股平均股价（880003）
数据来源：tushare（或本地fallback）
判断逻辑：
  - 多头：收盘价在短期均线上方，且均线趋势向上
  - 空头：收盘价跌破短期均线，或跌破近期低点
  - 破位：收盘价跌破长期均线或跌破近期N日低点，信号加强
"""

import pandas as pd
from timing.factors.base import BaseFactor, Signal, calc_ma, is_above_ma, is_trend_up, is_break_low
from timing.config import AVG_PRICE_CODE, MA_SHORT, MA_LONG, LOW_WINDOW
from timing.data_fetcher import fetch_avg_price, fetch_index_daily


class AvgPriceFactor(BaseFactor):
    """A股平均股价择时因子"""

    def __init__(self, weight: float = 1.0):
        super().__init__(name="A股平均股价", weight=weight)

    def load_data(self) -> pd.DataFrame:
        """加载平均股价数据，tushare失败时fallback用所有A股均价近似"""
        df = fetch_avg_price()
        if df is not None and not df.empty:
            # 确保有 close 列
            if "close" in df.columns:
                return df
        # Fallback：880003 获取不到，尝试用上证指数近似（仅作趋势参考）
        # 更好的方式是用全市场股票均价，但数据量大；这里先fallback到上证指数
        print("[WARN] 880003 平均股价获取失败，fallback 到上证指数作为趋势参考")
        df = fetch_index_daily("000001.SH")
        return df

    def calculate_signal(self, df: pd.DataFrame) -> Signal:
        df = df.copy()
        df["ma_short"] = calc_ma(df, "close", MA_SHORT)
        df["ma_long"] = calc_ma(df, "close", MA_LONG)

        # 取最新数据
        latest = df.iloc[-1]
        prev = df.iloc[-2] if len(df) > 1 else latest

        close = latest["close"]
        ma_s = latest["ma_short"]
        ma_l = latest["ma_long"]
        ma_s_prev = prev["ma_short"]

        above_short = close > ma_s
        above_long = close > ma_l
        ma_rising = ma_s > ma_s_prev  # 短期均线是否向上
        broke_low = is_break_low(df["close"], LOW_WINDOW)
        broke_long = close < ma_l

        # 信号判断 — 破位优先级最高
        if broke_long or broke_low:
            detail = f"收盘价 {close:.2f} 跌破 {'长期均线' if broke_long else ''}{' / ' if broke_long and broke_low else ''}{'近期低点' if broke_low else ''}"
            return Signal(Signal.BEAR, self.name, detail=detail, weight=self.weight)

        if above_short and ma_rising:
            detail = f"收盘价 {close:.2f} 在 MA{MA_SHORT} 上方，短期均线向上"
            return Signal(Signal.BULL, self.name, detail=detail, weight=self.weight)

        if not above_short:
            detail = f"收盘价 {close:.2f} 跌破 MA{MA_SHORT}"
            return Signal(Signal.BEAR, self.name, detail=detail, weight=self.weight)

        detail = f"收盘价 {close:.2f} 位于 MA{MA_SHORT} 附近，趋势不明"
        return Signal(Signal.NEUTRAL, self.name, detail=detail, weight=self.weight)
