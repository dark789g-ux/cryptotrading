"""行业内成交量集中度（HHI）。

定义：
    对每个行业 I 在 T 日，按行业内股票成交量 vol 计算 HHI（赫芬达尔指数）：
        share_i = vol_i / sum(vol over j in I)
        HHI_I   = sum( share_i ** 2 )
    再贴回个股（同一行业的每只票拿同一 HHI）。

含义：
    HHI 高 = 行业内少数票吃掉绝大部分成交（龙头独大 / 抱团），
    HHI 低 = 行业内成交分散（轮动 / 普涨）。

PIT 窗口：只需 T 日数据，取 5 日历日（含周末缓冲）。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="sector_volume_concentration", factor_version="v1")
class SectorVolumeConcentration(Factor):
    required_columns = ("vol", "industry_l1")

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        # 只取 T 日切片
        t_slice = df.xs(trade_date, level="trade_date")
        vol = t_slice["vol"].astype(float)
        ind = t_slice["industry_l1"]
        tmp = pd.DataFrame({"vol": vol, "industry_l1": ind}).dropna(
            subset=["industry_l1"]
        )

        def _hhi(s: pd.Series) -> float:
            total = s.sum()
            if total <= 0:
                return float("nan")
            share = s / total
            return float((share**2).sum())

        hhi = tmp.groupby("industry_l1")["vol"].apply(_hhi)
        out = tmp["industry_l1"].map(hhi)
        return out.reindex(vol.index).astype(float)
