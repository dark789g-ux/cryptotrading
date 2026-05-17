"""行业派生因子。

5 个本轮交付因子：
    industry_momentum_20d        行业动量（行业内 pct_chg 均值 20 日累计）
    industry_relative_strength   个股相对行业收益（alpha vs industry）
    industry_rank_in_sector      个股在所属行业内的横截面排名
    sector_volume_concentration  行业内成交量集中度（HHI）
    industry_neutral_momentum    行业中性化后的个股动量

关键 PIT 约束（doc/量化/03 三幽灵 Bug + doc/量化/07 §7.4）：
- 行业归属必须用**当时**的 raw.index_member 快照（按 in_date / out_date 筛选）
- 不要用当前 index_member 表的 latest 视图回测历史
"""
