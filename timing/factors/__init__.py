# -*- coding: utf-8 -*-
"""
factors 包初始化
导出所有可用因子
"""

from timing.factors.avg_price import AvgPriceFactor
from timing.factors.margin import MarginFactor
from timing.factors.turnover import TurnoverFactor
from timing.factors.index_trend import IndexTrendFactor
from timing.factors.active_mv import ActiveMVFactor

__all__ = [
    "AvgPriceFactor",
    "MarginFactor",
    "TurnoverFactor",
    "IndexTrendFactor",
    "ActiveMVFactor",
]
