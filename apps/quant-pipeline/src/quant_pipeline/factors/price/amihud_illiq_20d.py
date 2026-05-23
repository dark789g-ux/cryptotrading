"""Amihud 非流动性指标（20 日）。

定义（Amihud 2002）：
    daily_ret_i(t)  = close_adj_i(t) / close_adj_i(t-1) - 1
    illiq_i(t)      = |daily_ret_i(t)| / amount_i(t)
    AMIHUD_20D(T)   = mean(illiq_i(t) for t in last 20 trade days ≤ T)

经济含义：单位成交额引发的价格变动；高值 → 流动性差。
规模：amount 通常单位为元；这里不做单位归一化，因子值的相对排序才是模型用的。
为避免除零，amount<=0 的样本计入 NaN（停牌日通常 amount=0）。

依赖列：close_adj、amount
PIT 窗口：35 日历日（≈ 21 个交易日 + 节假日缓冲）
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="amihud_illiq_20d", factor_version="v1", min_trade_days=21)
class AmihudIlliq20d(Factor):
    required_columns = ("close_adj", "amount")

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        amount = df["amount"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]
        amount = amount.loc[:trade_date]
        # 需要至少 21 天历史以算出 20 个日收益率
        if len(close) < self.min_trade_days:
            return pd.Series(dtype=float)
        # 日收益率（最近 20 天）
        ret = close.pct_change().iloc[-20:]
        amt = amount.iloc[-20:].where(lambda x: x > 0, other=np.nan)
        illiq = ret.abs() / amt
        out = illiq.mean(axis=0, skipna=True)
        return out.astype(float)
