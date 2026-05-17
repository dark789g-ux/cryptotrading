"""60 日最大回撤。

定义：
    在 [T-59, T] 的 close_adj 序列上，
    drawdown_t = close_adj(t) / max(close_adj[T-59..t]) - 1
    price_max_drawdown_60d = min(drawdown_t) over the window  （负值）

PIT 窗口：100 日历日。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register

_N = 60


@register(factor_id="price_max_drawdown_60d", factor_version="v1")
class PriceMaxDrawdown60d(Factor):
    category = "price"
    pit_window_days = 100
    description = "60 日 close_adj 序列上的最大回撤（负值）"
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]
        if len(close) < _N:
            return pd.Series(dtype=float)
        window = close.tail(_N)
        # 累计 cummax 后求 drawdown
        cummax = window.cummax()
        dd = window / cummax - 1.0
        out = dd.min()
        return out.astype(float)
