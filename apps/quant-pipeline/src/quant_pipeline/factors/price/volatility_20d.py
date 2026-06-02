"""20 日波动率。

定义：
    volatility_20d(T) = std( daily_log_return ) over last 20 trading days
    daily_log_return = ln(close_adj(t)) - ln(close_adj(t-1))

注意：用对数收益率（更接近正态、可加性），与简单收益率相比对极端值更稳健。
PIT 窗口：需要回看 21 个交易日（20 个收益率） → 35 日历日。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="volatility_20d", factor_version="v1", min_trade_days=21)
class Volatility20d(Factor):
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]  # type: ignore[misc]  # pandas 标签切片：str 标签运行时合法，stub 误判 slice index 类型
        if len(close) < self.min_trade_days:
            return pd.Series(dtype=float)
        log_close = np.log(close.tail(21))
        log_ret = log_close.diff().tail(20)  # 20 个收益率
        return log_ret.std(ddof=1).astype(float)
