"""20 日换手率均值。

定义：
    turnover_mean_20d(T) = mean(turnover_rate over [T-19, T])

turnover_rate 来自 raw.daily_basic.turnover_rate（流通市值口径，TuShare 单位 %）。
PIT 窗口：35 日历日。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="turnover_mean_20d", factor_version="v1", min_trade_days=20)
class TurnoverMean20d(Factor):
    required_columns = ("turnover_rate",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        tr = df["turnover_rate"].unstack("ts_code").sort_index()
        if trade_date not in tr.index:
            return pd.Series(dtype=float)
        tr = tr.loc[:trade_date]  # type: ignore[misc]  # pandas 标签切片：str 标签运行时合法，stub 误判 slice index 类型
        if len(tr) < self.min_trade_days:
            return pd.Series(dtype=float)
        out = tr.tail(20).mean()
        return out.astype(float)
