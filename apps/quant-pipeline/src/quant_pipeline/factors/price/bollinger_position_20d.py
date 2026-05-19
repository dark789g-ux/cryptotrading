"""布林带位置。

定义：
    mid    = mean(close_adj[T-19..T])
    sigma  = std(close_adj[T-19..T], ddof=1)
    upper  = mid + 2 * sigma
    lower  = mid - 2 * sigma
    bollinger_position = (close_adj(T) - lower) / (upper - lower)

值域近似 [0, 1]（极端行情可越界）。0.5 = 在中轨，1 = 触及上轨。
PIT 窗口：35 日历日。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register

_N = 20


@register(factor_id="bollinger_position_20d", factor_version="v1")
class BollingerPosition20d(Factor):
    category = "price"
    pit_window_days = 35
    description = "(close - lower_band) / (upper_band - lower_band) over 20d, k=2"
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]
        if len(close) < _N:
            return pd.Series(dtype=float)
        window = close.tail(_N)
        mid = window.mean()
        sigma = window.std(ddof=1)
        upper = mid + 2 * sigma
        lower = mid - 2 * sigma
        c_t = close.iloc[-1]
        denom = (upper - lower).replace(0, np.nan)
        out = (c_t - lower) / denom
        return out.astype(float)
