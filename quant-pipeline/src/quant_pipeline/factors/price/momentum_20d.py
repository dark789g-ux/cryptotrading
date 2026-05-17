"""20 日动量。

定义：
    momentum_20d(T) = close_adj(T) / close_adj(T-20) - 1

依赖列：close_adj（后复权收盘，runner 用 raw.adj_factor 反推后塞入）

PIT 窗口：
    需要回看 21 个交易日 → 取 35 日历日（≈21 * 1.6，含节假日缓冲）。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="momentum_20d", factor_version="v1")
class Momentum20d(Factor):
    category = "price"
    pit_window_days = 35
    description = "20 日动量 close_adj(T) / close_adj(T-20) - 1"
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        # df 索引: [trade_date, ts_code]; 列含 close_adj
        # 取出每只票按 trade_date 升序的最近 21 个交易日 close_adj
        close = df["close_adj"].unstack("ts_code").sort_index()  # 形状: [date, ts_code]
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        # 在窗口内只保留 T 及之前
        close = close.loc[:trade_date]
        if len(close) < 21:
            return pd.Series(dtype=float)
        # T-20 即倒数第 21 个交易日；T 即最后一个
        c_t = close.iloc[-1]
        c_lag = close.iloc[-21]
        out = c_t / c_lag - 1.0
        return out.astype(float)
