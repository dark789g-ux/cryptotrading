"""行业动量 20 日。

定义（doc/量化/07 §7.2 行业动量）：
    对每个交易日 t 与每个申万一级行业 i：
        industry_ret_t_i = mean( pct_chg_t over stocks in i at t )
    industry_momentum_20d(T) = sum( industry_ret_t_i ) over t in [T-19, T]
    然后贴回个股：每只票拿其当时所属行业的因子值

注意：
- pct_chg 用后复权 close_adj 反推（避免复权陷阱）：
    pct_chg_t = close_adj_t / close_adj_{t-1} - 1
- 行业归属用 PIT 安全的 industry_l1（runner 已按 raw.index_member 解析）
  ——不要用当前行业表的 latest 视图

PIT 窗口：21 个交易日 → 35 日历日。
"""

from __future__ import annotations

import pandas as pd

from quant_pipeline.factors.base import Factor
from quant_pipeline.factors.registry import register


@register(factor_id="industry_momentum_20d", factor_version="v1", min_trade_days=21)
class IndustryMomentum20d(Factor):
    required_columns = ("close_adj", "industry_l1")

    def compute(self, df: pd.DataFrame, trade_date: str) -> pd.Series:
        # df: MultiIndex [trade_date, ts_code]; cols: close_adj, industry_l1
        # 由后复权 close_adj 算 pct_chg
        close = df["close_adj"].unstack("ts_code").sort_index()
        if trade_date not in close.index:
            return pd.Series(dtype=float)
        close = close.loc[:trade_date]  # type: ignore[misc]  # pandas 标签切片：str 标签运行时合法，stub 误判 slice index 类型
        if len(close) < self.min_trade_days:
            return pd.Series(dtype=float)
        pct_chg = close.pct_change().tail(20)  # 20 个交易日的收益率
        # industry_l1：取 T 日切片（按当时归属）
        ind_t = df["industry_l1"].xs(trade_date, level="trade_date")
        # 把 pct_chg 转为长表后按 (date, industry) groupby 取均值
        long = pct_chg.stack().rename("pct_chg").reset_index()
        long = long.rename(columns={"level_0": "trade_date"})
        # ts_code 的列名取决于 unstack 时的 level 名
        if "ts_code" not in long.columns:
            long.columns = ["trade_date", "ts_code", "pct_chg"]
        # 用 T 日的行业归属近似窗口内行业（doc/07 标注的常见简化；严格 PIT 需逐日归属，
        # 但 20 日内行业极少变更，T 日切片足够；如需更严，runner 可在 df 里
        # 把每日归属一起带进来，本因子可改为 join 每日 industry_l1）
        long["industry_l1"] = long["ts_code"].map(ind_t)
        ind_ret = (
            long.dropna(subset=["industry_l1"])
            .groupby(["trade_date", "industry_l1"])["pct_chg"]
            .mean()
        )
        # 行业的 20 日累计
        ind_mom = ind_ret.groupby("industry_l1").sum()
        # 贴回个股（按 T 日归属）
        out = ind_t.map(ind_mom)
        return out.astype(float)
