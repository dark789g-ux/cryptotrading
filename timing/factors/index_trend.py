# -*- coding: utf-8 -*-
"""
因子4：指数趋势（上证、深证、创业板）
数据来源：本地 index_data / tushare
判断逻辑：
  每个指数独立判断：
    - 多头：收盘价在 MA20 上方，且均线向上
    - 空头：收盘价跌破 MA20
    - 破位：跌破 MA60 或近期低点
  三指数综合：
    - 2个以上看多 → 多头
    - 2个以上看空 → 空头
    - 其他 → 中性
"""

import pandas as pd
from timing.factors.base import BaseFactor, Signal, calc_ma, is_break_low
from timing.config import INDEX_CODES, MA_SHORT, MA_LONG, LOW_WINDOW
from timing.data_fetcher import fetch_index_daily


class IndexTrendFactor(BaseFactor):
    """多指数趋势择时因子"""

    def __init__(self, weight: float = 1.0):
        super().__init__(name="指数趋势", weight=weight)
        self.index_signals = {}  # 记录各子信号详情

    def load_data(self) -> pd.DataFrame:
        """返回一个合并后的 DataFrame，包含各指数收盘价"""
        merged = None
        for name, code in INDEX_CODES.items():
            df = fetch_index_daily(code)
            if df is None or df.empty:
                continue
            sub = df[["trade_date", "close"]].copy()
            sub.rename(columns={"close": f"close_{name}"}, inplace=True)
            if merged is None:
                merged = sub
            else:
                merged = pd.merge(merged, sub, on="trade_date", how="inner")
        return merged

    def _judge_single(self, series: pd.Series, name: str) -> int:
        """判断单个指数的多空状态，返回 1/0/-1"""
        df_temp = pd.DataFrame({"close": series.values})
        df_temp["ma_short"] = calc_ma(df_temp, "close", MA_SHORT)
        df_temp["ma_long"] = calc_ma(df_temp, "close", MA_LONG)

        if len(df_temp) < MA_LONG:
            return Signal.NEUTRAL

        latest = df_temp.iloc[-1]
        prev = df_temp.iloc[-2]

        close = latest["close"]
        ma_s = latest["ma_short"]
        ma_l = latest["ma_long"]
        ma_s_prev = prev["ma_short"]

        above_short = close > ma_s
        ma_rising = ma_s > ma_s_prev
        broke_long = close < ma_l
        broke_low = is_break_low(series, LOW_WINDOW)

        # 破位优先级最高
        if broke_long or broke_low:
            return Signal.BEAR
        if above_short and ma_rising:
            return Signal.BULL
        if not above_short:
            return Signal.BEAR
        return Signal.NEUTRAL

    def calculate_signal(self, df: pd.DataFrame) -> Signal:
        scores = []
        details = []
        for col in df.columns:
            if col.startswith("close_"):
                idx_name = col.replace("close_", "")
                label = {"sh": "上证", "sz": "深证", "cy": "创业板"}.get(idx_name, idx_name)
                score = self._judge_single(df[col], idx_name)
                scores.append(score)
                status = {1: "多头", 0: "中性", -1: "空头"}.get(score, "?")
                details.append(f"{label}: {status}")
                self.index_signals[idx_name] = score

        if not scores:
            return Signal(Signal.NEUTRAL, self.name, detail="无指数数据", weight=self.weight)

        bull_count = sum(1 for s in scores if s == Signal.BULL)
        bear_count = sum(1 for s in scores if s == Signal.BEAR)
        total = len(scores)

        detail = " | ".join(details)

        if bull_count >= 2:
            return Signal(Signal.BULL, self.name, detail=detail, weight=self.weight)
        if bear_count >= 2:
            return Signal(Signal.BEAR, self.name, detail=detail, weight=self.weight)
        return Signal(Signal.NEUTRAL, self.name, detail=detail, weight=self.weight)
