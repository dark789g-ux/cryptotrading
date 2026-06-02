"""收盘 / MA20。

定义：
    ma_ratio_20d(T) = close_adj(T) / mean(close_adj over [T-19, T])

> 1 表示价格在均线上方，< 1 表示下方。PIT 窗口：35 日历日。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="ma_ratio_20d", factor_version="v1", min_trade_days=20)
class MaRatio20d(Factor):
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]  # type: ignore[misc]  # pandas 标签切片：str 标签运行时合法，stub 误判 slice index 类型
        if len(close) < self.min_trade_days:
            return pd.Series(dtype=float)
        ma20 = close.tail(20).mean()
        c_t = close.iloc[-1]
        out = c_t / ma20
        return out.astype(float)
