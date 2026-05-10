# -*- coding: utf-8 -*-
"""
因子3：两市总成交额
数据来源：上证指数+深证成指 amount 近似（因为 tushare 无直接全市场成交额接口）
判断逻辑：
  - 放量上涨：近5日均额 > 近20日均额 * 1.1 且 指数在均线上方 → 多头
  - 放量下跌：近5日均额 > 近20日均额 * 1.1 且 指数跌破均线 → 空头
  - 缩量：近5日均额 < 近20日均额 * 0.9 → 中性（观望）
  - 其他：跟随趋势
"""

import pandas as pd
from timing.factors.base import BaseFactor, Signal, calc_ma
from timing.config import VOLUME_RATIO_THRESHOLD
from timing.data_fetcher import fetch_moneyflow_summary


class TurnoverFactor(BaseFactor):
    """两市成交额择时因子"""

    def __init__(self, weight: float = 0.8):
        super().__init__(name="两市成交额", weight=weight)

    def load_data(self) -> pd.DataFrame:
        return fetch_moneyflow_summary()

    def calculate_signal(self, df: pd.DataFrame) -> Signal:
        df = df.copy()
        col = "total_amount"
        if col not in df.columns:
            return Signal(Signal.NEUTRAL, self.name, detail="成交额数据缺失", weight=self.weight)

        # 计算成交额均线
        df["ma5"] = calc_ma(df, col, 5)
        df["ma20"] = calc_ma(df, col, 20)

        latest = df.iloc[-1]
        val = latest[col]
        ma5 = latest["ma5"]
        ma20 = latest["ma20"]

        # 判断是否放量/缩量
        if ma20 == 0 or pd.isna(ma20):
            return Signal(Signal.NEUTRAL, self.name, detail="成交额均线不足，无法判断", weight=self.weight)

        ratio = ma5 / ma20
        is_expand = ratio > VOLUME_RATIO_THRESHOLD
        is_shrink = ratio < (1 / VOLUME_RATIO_THRESHOLD)

        # 判断成交额趋势
        amount_rising = ma5 > ma20

        # 成交额本身不直接给多空头，而是看放量/缩量的配合
        if is_expand:
            if amount_rising:
                detail = f"放量上涨，近5日成交额 {ma5/1e5:.0f}亿 较20日均额放大 {ratio:.2f}倍，资金进场"
                return Signal(Signal.BULL, self.name, detail=detail, weight=self.weight)
            else:
                detail = f"放量下跌，近5日成交额 {ma5/1e5:.0f}亿 放大 {ratio:.2f}倍，资金出逃"
                return Signal(Signal.BEAR, self.name, detail=detail, weight=self.weight)

        if is_shrink:
            detail = f"缩量，近5日成交额 {ma5/1e5:.0f}亿 较20日均额萎缩 {1/ratio:.2f}倍，市场观望"
            return Signal(Signal.NEUTRAL, self.name, detail=detail, weight=self.weight)

        # 温和量能，跟随趋势
        if amount_rising:
            detail = f"成交额温和回升，MA5 {ma5/1e5:.0f}亿 > MA20 {ma20/1e5:.0f}亿"
            return Signal(Signal.BULL, self.name, detail=detail, weight=self.weight)
        else:
            detail = f"成交额温和下降，MA5 {ma5/1e5:.0f}亿 < MA20 {ma20/1e5:.0f}亿"
            return Signal(Signal.BEAR, self.name, detail=detail, weight=self.weight)
