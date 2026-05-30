"""20 日成交量比。

定义：
    volume_ratio_20d(T) = vol(T) / mean(vol over [T-20, T-1])

成交量不需要后复权（量比与价格复权无关）。
PIT 窗口：35 日历日。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="volume_ratio_20d", factor_version="v1", min_trade_days=21)
class VolumeRatio20d(Factor):
    required_columns = ("vol",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        vol = df["vol"].unstack("ts_code").sort_index()
        if trade_date not in vol.index:
            return pd.Series(dtype=float)
        vol = vol.loc[:trade_date]  # type: ignore[misc]  # pandas 标签切片：str 标签运行时合法，stub 误判 slice index 类型
        if len(vol) < self.min_trade_days:
            return pd.Series(dtype=float)
        v_t = vol.iloc[-1]
        v_mean = vol.iloc[-21:-1].mean()  # 不含 T 日
        out = v_t / v_mean
        return out.astype(float)
