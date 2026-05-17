"""个股在所属行业内的横截面排名（基于 20 日动量）。

定义（doc/量化/07 §7.2 行业内排名）：
    momentum_20d_i = close_adj_i(T) / close_adj_i(T-20) - 1
    rank_in_sector = pct_rank(momentum_20d) within (T, industry_l1)
    值域 [0, 1]；1 = 行业内动量最强。

注：本因子是"已有因子的行业内排名"模板，doc/07 §7.5 提到的"加关键因子的行业内排名"，
此处先以 20 日动量为示例；后续可派生多个 `{factor}_rank_in_sector_v1`。

PIT 窗口：35 日历日。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="industry_rank_in_sector_mom20", factor_version="v1")
class IndustryRankInSector(Factor):
    category = "industry"
    pit_window_days = 35
    description = "20 日动量在所属一级行业内的横截面 pct_rank（[0,1]）"
    required_columns = ("close_adj", "industry_l1")

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]
        if len(close) < 21:
            return pd.Series(dtype=float)
        mom = close.iloc[-1] / close.iloc[-21] - 1.0
        ind_t = df["industry_l1"].xs(trade_date, level="trade_date")
        tmp = pd.DataFrame({"mom": mom, "industry_l1": ind_t}).dropna(
            subset=["industry_l1"]
        )
        # 行业内 pct_rank（method='average' / pct=True）
        out = tmp.groupby("industry_l1")["mom"].rank(method="average", pct=True)
        return out.reindex(mom.index).astype(float)
