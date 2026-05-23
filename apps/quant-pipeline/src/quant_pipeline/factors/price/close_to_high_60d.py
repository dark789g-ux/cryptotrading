"""收盘相对 60 日高点。

定义：
    close_to_high_60d(T) = close_adj(T) / max(close_adj[T-59..T])

值域 (0, 1]；越接近 1 表示当前价距离 60 日新高越近（强势）。
PIT 窗口：需 60 交易日。原 100 日历日裕度偏紧，提到 115（review §8）。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register

_N = 60


@register(factor_id="close_to_high_60d", factor_version="v1")
class CloseToHigh60d(Factor):
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]
        if len(close) < _N:
            return pd.Series(dtype=float)
        window = close.tail(_N)
        high = window.max()
        c_t = close.iloc[-1]
        out = c_t / high
        return out.astype(float)
