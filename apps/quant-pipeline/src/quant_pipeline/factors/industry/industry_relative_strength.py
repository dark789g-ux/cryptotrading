"""个股相对行业收益（alpha vs industry）。

定义（doc/量化/07 §7.2 个股相对行业强度）：
    stock_ret_20d_i    = close_adj_i(T) / close_adj_i(T-20) - 1
    industry_ret_20d_I = mean(stock_ret_20d_j for j in industry I at T)
    alpha_vs_industry  = stock_ret_20d_i - industry_ret_20d_I

剔除行业 β，留下纯个股 α。强信号（doc/07）。
PIT 窗口：35 日历日（同 momentum_20d）。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="industry_relative_strength", factor_version="v1")
class IndustryRelativeStrength(Factor):
    required_columns = ("close_adj", "industry_l1")

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]
        if len(close) < 21:
            return pd.Series(dtype=float)
        stock_ret = close.iloc[-1] / close.iloc[-21] - 1.0
        ind_t = df["industry_l1"].xs(trade_date, level="trade_date")
        tmp = pd.DataFrame({"ret": stock_ret, "industry_l1": ind_t})
        ind_mean = tmp.dropna(subset=["industry_l1"]).groupby("industry_l1")["ret"].mean()
        out = tmp["ret"] - tmp["industry_l1"].map(ind_mean)
        return out.astype(float)
