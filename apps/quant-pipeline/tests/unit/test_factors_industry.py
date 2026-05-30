"""5 个行业派生因子的单测。

关键 PIT 校验（doc/量化/03 三幽灵 Bug）：
- 行业归属来自 df['industry_l1']（runner 已用 raw.index_member 的 in_date/out_date 解析）
- 单测不直接验证"PIT 当时成份股"——那需要 raw.index_member 集成测试

# TODO: 集成测试验证 API 契约 —— Part C/E 完成后必须用真实 raw.index_member
# 跑一遍验证：某只票在 2018-01 与 2024-06 行业归属变更，因子值会切换到不同分组。
"""

from __future__ import annotations

import numpy as np
import pandas as pd

from quant_pipeline.factors.registry import get_factor

# ----------------------------------------------------------------------
# industry_momentum_20d
# ----------------------------------------------------------------------

def test_industry_momentum_20d_same_within_industry(small_panel: pd.DataFrame) -> None:
    f = get_factor("industry_momentum_20d", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    # 同行业的票拿到同一个因子值
    ind_t = small_panel["industry_l1"].xs(t, level="trade_date")
    # 银行行业的两只票：000001.SZ, 600000.SH
    banks = ind_t[ind_t == "801780.SI"].index
    if len(banks) >= 2:
        vals = out.loc[banks].dropna().unique()
        assert len(vals) == 1, f"同行业因子值应相同，得到 {vals}"


# ----------------------------------------------------------------------
# industry_relative_strength
# ----------------------------------------------------------------------

def test_industry_relative_strength_sums_to_zero_within_industry(
    small_panel: pd.DataFrame,
) -> None:
    f = get_factor("industry_relative_strength", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t)
    ind_t = small_panel["industry_l1"].xs(t, level="trade_date")
    # 行业内"个股 alpha"之和应当为 0
    tmp = pd.DataFrame({"alpha": out, "industry_l1": ind_t}).dropna()
    sums = tmp.groupby("industry_l1")["alpha"].sum()
    np.testing.assert_allclose(sums.values, 0.0, atol=1e-9)


# ----------------------------------------------------------------------
# industry_rank_in_sector
# ----------------------------------------------------------------------

def test_industry_rank_in_sector_pct_range(small_panel: pd.DataFrame) -> None:
    f = get_factor("industry_rank_in_sector_mom20", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t).dropna()
    # pct_rank ∈ (0, 1]
    assert (out > 0).all() and (out <= 1.0).all()


# ----------------------------------------------------------------------
# sector_volume_concentration
# ----------------------------------------------------------------------

def test_sector_volume_concentration_hhi_range(small_panel: pd.DataFrame) -> None:
    f = get_factor("sector_volume_concentration", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out = f.compute(small_panel, t).dropna()
    # HHI ∈ (0, 1]；1 = 行业内只有一只票（垄断），1/N = 完全均匀
    assert (out > 0).all() and (out <= 1.0 + 1e-9).all()


def test_sector_volume_concentration_single_stock_industry_equals_one() -> None:
    """单只票独占一个行业 → HHI = 1。"""

    f = get_factor("sector_volume_concentration", "v1")
    df = pd.DataFrame(
        {
            "trade_date": ["20240102", "20240102"],
            "ts_code": ["A.SZ", "B.SZ"],
            "vol": [100.0, 200.0],
            "industry_l1": ["IND_ALONE", "IND_OTHER"],
        }
    ).set_index(["trade_date", "ts_code"])
    out = f.compute(df, "20240102")
    assert out["A.SZ"] == 1.0
    assert out["B.SZ"] == 1.0


# ----------------------------------------------------------------------
# industry_neutral_momentum (momentum_20d_neu)
# ----------------------------------------------------------------------

def test_industry_neutral_momentum_equals_relative_strength(
    small_panel: pd.DataFrame,
) -> None:
    """中性化动量与 industry_relative_strength 数值等价（doc/07 §7.3 同源）。"""

    neu = get_factor("momentum_20d_neu", "v1")
    rel = get_factor("industry_relative_strength", "v1")
    trade_dates = sorted(
        small_panel.index.get_level_values("trade_date").unique().tolist()
    )
    t = trade_dates[40]
    out_neu = neu.compute(small_panel, t).sort_index()
    out_rel = rel.compute(small_panel, t).sort_index()
    pd.testing.assert_series_equal(out_neu, out_rel, check_names=False)


# ----------------------------------------------------------------------
# 通用：所有行业因子都正确声明 pit_window_days > 0 且 category='industry'
# ----------------------------------------------------------------------

def test_all_industry_factors_metadata() -> None:
    from quant_pipeline.factors.registry import list_factors

    inds = list_factors(category="industry")
    assert len(inds) == 5
    for f in inds:
        assert f.pit_window_days > 0
        assert f.pit_anchor == "trade_date"
        assert "industry_l1" in f.required_columns
