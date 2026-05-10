# -*- coding: utf-8 -*-
"""
因子5：活跃市值（0AMV）

数据来源：
  - 本地计算: timing/0amv_calc/data/0amv_result.csv（基于 930903 + 通达信递推 + 拟合系数 0.87）
  - 实时 API: stock.svip886.com/api/indexes（用于对比验证）

信号规则（Phase 2 验证通过）:
  - 单日涨幅 >= +2.0% → 多头(+1)
  - 单日跌幅 <= -1.8% → 空头(-1)
  - 否则 → 中性(0)
"""

import os
import pandas as pd
from timing.factors.base import BaseFactor, Signal
from timing.data_fetcher_0amv import fetch_0amv_via_api
from timing.config import OAMV_BULL_THRESHOLD, OAMV_BEAR_THRESHOLD

# 本地计算结果路径
_OAMV_RESULT_PATH = os.path.join(
    os.path.dirname(os.path.dirname(__file__)),
    "0amv_calc", "data", "0amv_result.csv"
)


class ActiveMVFactor(BaseFactor):
    """活跃市值择时因子 — 基于本地精确计算"""

    def __init__(self, weight: float = 1.5):
        super().__init__(name="活跃市值(0AMV)", weight=weight)

    def load_data(self) -> pd.DataFrame:
        """加载本地计算的 0AMV 数据"""
        # 优先本地计算结果
        if os.path.exists(_OAMV_RESULT_PATH):
            df = pd.read_csv(_OAMV_RESULT_PATH, dtype={"trade_date": str})
            return df
        # fallback: API
        print("[0AMV] 本地计算结果不存在，回退到 API")
        data = fetch_0amv_via_api()
        if data:
            return pd.DataFrame([data])
        return pd.DataFrame()

    def calculate_signal(self, df: pd.DataFrame) -> Signal:
        if df.empty:
            return Signal(
                Signal.NEUTRAL,
                self.name,
                detail="0AMV 数据不可用",
                weight=self.weight,
            )

        # 本地计算结果列: oamv_zdf
        if "oamv_zdf" in df.columns:
            chg = df["oamv_zdf"].iloc[-1]
            oamv = df["oamvc"].iloc[-1]
            detail_prefix = f"计算0AMV={oamv:,.0f}"
        elif "0amv_chg_pct" in df.columns:
            # API fallback
            chg = df["0amv_chg_pct"].iloc[-1]
            oamv = df["0amv"].iloc[-1]
            detail_prefix = f"API 0AMV={oamv:,.0f}"
        else:
            return Signal(
                Signal.NEUTRAL,
                self.name,
                detail="0AMV 数据列缺失",
                weight=self.weight,
            )

        bull_thr = OAMV_BULL_THRESHOLD  # +2.5%
        bear_thr = OAMV_BEAR_THRESHOLD  # -1.8%
        bull_cum2_thr = OAMV_BULL_CUM2_THRESHOLD  # +2.8% (2日累计备份)

        # 计算2日累计涨幅（当日 + 前1日）
        cum2 = None
        if "oamv_zdf" in df.columns and len(df) >= 2:
            cum2 = df["oamv_zdf"].iloc[-1] + df["oamv_zdf"].iloc[-2]

        # 多头触发：单日 >= +2.5% OR 2日累计 >= +2.8%
        is_bull = (chg >= bull_thr) or (cum2 is not None and cum2 >= bull_cum2_thr)
        # 空头触发：单日 <= -1.8%
        is_bear = chg <= bear_thr

        if is_bull:
            trigger_detail = f"单日涨 {chg:+.2f}% (>={bull_thr}%)"
            if cum2 is not None and cum2 >= bull_cum2_thr and chg < bull_thr:
                trigger_detail = f"2日累计涨 {cum2:+.2f}% (>={bull_cum2_thr}%)"
            return Signal(
                Signal.BULL, self.name,
                detail=f"{detail_prefix} {trigger_detail}，向上拐点",
                weight=self.weight
            )
        elif is_bear:
            return Signal(
                Signal.BEAR, self.name,
                detail=f"{detail_prefix} 单日跌 {chg:+.2f}% (<={bear_thr}%)，向下拐点",
                weight=self.weight
            )
        else:
            return Signal(
                Signal.NEUTRAL, self.name,
                detail=f"{detail_prefix} 涨 {chg:+.2f}% (未触发阈值)",
                weight=self.weight
            )
