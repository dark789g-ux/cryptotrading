"""行业中性化后的个股动量。

定义（doc/量化/07 §7.3 行业中性化）：
    momentum_20d_i = close_adj_i(T) / close_adj_i(T-20) - 1
    industry_mean  = mean(momentum_20d_j for j in industry I at T)
    industry_neutral_momentum_i = momentum_20d_i - industry_mean

与 `industry_relative_strength` 数值等价，但语义上属于"原始因子的 _neu 版本"
（doc/07 §7.3 推荐两个版本都给模型挑）。

PIT 窗口：35 日历日。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="momentum_20d_neu", factor_version="v1", min_trade_days=21)
class IndustryNeutralMomentum(Factor):
    required_columns = ("close_adj", "industry_l1")

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]  # type: ignore[misc]  # pandas 标签切片：str 标签运行时合法，stub 误判 slice index 类型
        if len(close) < self.min_trade_days:
            return pd.Series(dtype=float)
        mom = close.iloc[-1] / close.iloc[-21] - 1.0
        ind_t = df["industry_l1"].xs(trade_date, level="trade_date")
        tmp = pd.DataFrame({"mom": mom, "industry_l1": ind_t})
        ind_mean = tmp.dropna(subset=["industry_l1"]).groupby("industry_l1")["mom"].mean()
        out = tmp["mom"] - tmp["industry_l1"].map(ind_mean)
        return out.astype(float)
