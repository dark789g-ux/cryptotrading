"""RSI 14（Wilder 平滑）。

定义：
    daily_change = close_adj(t) - close_adj(t-1)
    up = max(daily_change, 0); down = max(-daily_change, 0)
    avg_up_t   = ((N-1) * avg_up_{t-1}   + up_t)   / N    （Wilder 平滑）
    avg_down_t = ((N-1) * avg_down_{t-1} + down_t) / N
    rsi = 100 - 100 / (1 + avg_up / avg_down)

N=14；首个 avg 用前 14 日简单均值初始化。
PIT 窗口：N + 一些 burn-in（Wilder 平滑收敛慢）取 60 日历日（约 37 交易日）。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register

_N = 14


@register(factor_id="rsi_14", factor_version="v1")
class Rsi14(Factor):
    category = "price"
    pit_window_days = 60
    description = "RSI(14) with Wilder smoothing"
    required_columns = ("close_adj",)

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]
        if len(close) < _N + 1:
            return pd.Series(dtype=float)
        delta = close.diff().dropna(how="all")
        up = delta.clip(lower=0)
        down = (-delta).clip(lower=0)
        # Wilder 平滑：EMA alpha = 1/N
        avg_up = up.ewm(alpha=1 / _N, adjust=False, min_periods=_N).mean()
        avg_down = down.ewm(alpha=1 / _N, adjust=False, min_periods=_N).mean()
        # 单调上涨时 avg_down=0 → RSI=100；保护除 0 时直接置 100
        rsi = pd.DataFrame(
            np.where(
                avg_down.values == 0,
                100.0,
                100.0 - 100.0 / (1.0 + avg_up.values / np.where(
                    avg_down.values == 0, np.nan, avg_down.values
                )),
            ),
            index=avg_up.index,
            columns=avg_up.columns,
        )
        out = rsi.iloc[-1]
        return out.astype(float)
