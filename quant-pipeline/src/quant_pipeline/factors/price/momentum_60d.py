"""60 日动量。

定义：
    momentum_60d(T) = close_adj(T) / close_adj(T-60) - 1

PIT 窗口：需要回看 61 个交易日 → 取 100 日历日。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="momentum_60d", factor_version="v1")
class Momentum60d(Factor):
    category = "price"
    pit_window_days = 100
    description = "60 日动量 close_adj(T) / close_adj(T-60) - 1"
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]
        if len(close) < 61:
            return pd.Series(dtype=float)
        c_t = close.iloc[-1]
        c_lag = close.iloc[-61]
        out = c_t / c_lag - 1.0
        return out.astype(float)
