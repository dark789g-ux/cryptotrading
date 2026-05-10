# -*- coding: utf-8 -*-
"""
因子基类
所有择时因子继承此类，统一输出接口
"""

import pandas as pd
from abc import ABC, abstractmethod
from typing import Dict, Any


class Signal:
    """单个因子信号封装"""
    BULL = 1      # 多头
    NEUTRAL = 0   # 中性
    BEAR = -1     # 空头

    def __init__(self, value: int, name: str, detail: str = "", weight: float = 1.0):
        self.value = value          # 1 / 0 / -1
        self.name = name            # 因子名
        self.detail = detail        # 判断详情
        self.weight = weight        # 权重

    def weighted_value(self) -> float:
        return self.value * self.weight

    def __repr__(self) -> str:
        labels = {1: "多头", 0: "中性", -1: "空头"}
        return f"[{self.name}] {labels.get(self.value, '?')} | {self.detail}"


class BaseFactor(ABC):
    """择时因子抽象基类"""

    def __init__(self, name: str, weight: float = 1.0):
        self.name = name
        self.weight = weight
        self.data = None

    @abstractmethod
    def load_data(self) -> pd.DataFrame:
        """加载数据，返回 DataFrame"""
        pass

    @abstractmethod
    def calculate_signal(self, df: pd.DataFrame) -> Signal:
        """
        基于最新数据计算信号
        返回 Signal 对象
        """
        pass

    def run(self) -> Signal:
        """执行完整流程：加载数据 -> 计算信号"""
        df = self.load_data()
        if df is None or df.empty:
            return Signal(Signal.NEUTRAL, self.name, detail="数据缺失，无法判断", weight=self.weight)
        self.data = df
        signal = self.calculate_signal(df)
        signal.weight = self.weight
        return signal


# ============ 通用计算工具 ============

def calc_ma(df: pd.DataFrame, col: str, window: int) -> pd.Series:
    """计算简单移动均线"""
    return df[col].rolling(window=window, min_periods=window).mean()


def calc_ema(df: pd.DataFrame, col: str, span: int) -> pd.Series:
    """计算指数移动均线"""
    return df[col].ewm(span=span, adjust=False).mean()


def is_above_ma(series: pd.Series, ma_series: pd.Series) -> bool:
    """判断最新值是否在均线上方"""
    if len(series) < 2 or len(ma_series) < 2:
        return False
    return series.iloc[-1] > ma_series.iloc[-1]


def is_trend_up(series: pd.Series, lookback: int = 5) -> bool:
    """
    判断近期趋势是否向上
    比较最近 lookback 期的首尾值
    """
    if len(series) < lookback:
        return False
    return series.iloc[-1] > series.iloc[-lookback]


def is_break_low(series: pd.Series, window: int = 30) -> bool:
    """
    判断是否跌破近期 window 日低点（包含等于）
    """
    if len(series) < window:
        return False
    recent_low = series.iloc[-window:].min()
    return series.iloc[-1] <= recent_low
