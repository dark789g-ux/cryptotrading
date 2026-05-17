"""factors 单测共享 fixture。

构造小样本：
- 5 只票（含 1 只行业 B、4 只行业 A，便于行业因子测试）
- 80 个交易日（足够 60 日窗口 + 一些缓冲）
- close_adj、vol、turnover_rate、industry_l1 全部预填
- 故意构造一笔"分红事件"在第 30 日（adj_factor 从 1.0 突变到 1.1），
  验证因子用 close_adj 而非 close 时仍然平滑

这是用 mock 数据驱动的单测；集成测试在 Part C/E 完成后用 docker-postgres 跑。
按 spec 04 §3 单测红线：mock 单测必须配套小样本真实数据集成测试，本批因子
集成测试由 Part E 在 quality 审计 + 小样本真实数据下补齐
（详见 # TODO: 集成测试 注释）。
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest


@pytest.fixture(autouse=True)
def _ensure_factors_loaded() -> None:
    """每个测试运行前确保 factors 已导入 + 注册。"""

    # 触发 import_all_factors 的副作用
    import quant_pipeline.factors  # noqa: F401


@pytest.fixture
def small_panel() -> pd.DataFrame:
    """5 只票 × 80 个交易日的小样本。

    返回 MultiIndex [trade_date, ts_code]，列：close, vol, adj_factor,
    turnover_rate, close_adj, industry_l1
    """

    rng = np.random.default_rng(42)
    # 模拟交易日：从 20240102 起 80 个工作日（用 BusinessDay）
    dates = pd.bdate_range("2024-01-02", periods=80).strftime("%Y%m%d").tolist()
    ts_codes = ["000001.SZ", "000002.SZ", "600000.SH", "600519.SH", "300750.SZ"]
    industries = {
        "000001.SZ": "801780.SI",  # 申万-银行
        "000002.SZ": "801180.SI",  # 申万-房地产
        "600000.SH": "801780.SI",  # 银行
        "600519.SH": "801120.SI",  # 食品饮料
        "300750.SZ": "801120.SI",  # 食品饮料
    }

    records = []
    # 每只票一条独立的随机游走 close
    for tc in ts_codes:
        # 起始价 10..50
        start_price = float(rng.uniform(10, 50))
        rets = rng.normal(0.0, 0.02, size=len(dates))  # 日收益率 ~ N(0, 2%)
        prices = start_price * np.exp(np.cumsum(rets))
        vols = rng.uniform(1e6, 5e6, size=len(dates))
        # 成交额（万元为常见单位；这里用 1e7..1e9 量级，便于 Amihud 数值稳定）
        amounts = rng.uniform(1e7, 1e9, size=len(dates))
        turnovers = rng.uniform(0.5, 5.0, size=len(dates))
        # 故意在第 30 日制造分红事件：close 跳水 10%，但 adj_factor 同步上调
        # 让 close_adj 仍然连续
        # 后复权基准：取窗口内 max(adj_factor)=1.1，所以前 30 日的 close_adj = close*1.0/1.1
        # 第 30 日及之后 close_adj = close*1.1/1.1 = close
        adj_factors = np.where(
            np.arange(len(dates)) < 30, 1.0, 1.1
        )
        # 制造分红事件：close 在第 30 日变小 10%（除权除息）
        prices[30:] *= 0.909  # close 直接跳水 1/1.1
        for i, dt in enumerate(dates):
            records.append(
                {
                    "trade_date": dt,
                    "ts_code": tc,
                    "close": float(prices[i]),
                    "vol": float(vols[i]),
                    "amount": float(amounts[i]),
                    "adj_factor": float(adj_factors[i]),
                    "turnover_rate": float(turnovers[i]),
                    "industry_l1": industries[tc],
                }
            )
    df = pd.DataFrame(records).set_index(["trade_date", "ts_code"]).sort_index()
    # close_adj = close * adj_factor / max(adj_factor)（窗口口径，runner 同款）
    af = df["adj_factor"]
    max_af = af.groupby(level="ts_code").transform("max")
    df["close_adj"] = df["close"] * af / max_af
    return df


@pytest.fixture
def trade_dates_80(small_panel: pd.DataFrame) -> list[str]:
    return sorted(small_panel.index.get_level_values("trade_date").unique().tolist())
