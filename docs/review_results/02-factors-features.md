# Code Review：`factors/` 因子 + `features/` 特征子系统

> 评审对象：`apps/quant-pipeline/src/quant_pipeline/factors/` 与 `features/`
> 评审重点：因子计算正确性、数据泄漏/PIT 违规、数据完整性、性能。
> 使用方式：新会话打开本文，逐条核实后再修复。

## 🔴 严重

### 1. `features/builder.py:300-322` — 市值中性化 β 估计实现脆弱（`groupby.apply` 跨 pandas 版本不稳）
`neutralize_by_industry_and_market_cap` 用 `grp.apply(lambda g: ...)` 计算每个 `trade_date` 的 `var(mv_z)`。`grp.apply` 返回 DataFrame 还是带 MultiIndex 的 Series 取决于 pandas 版本；新版 pandas（≥2.2）对返回 Series 的处理已变更，`["vz"]` 提取可能 `KeyError` 或返回错位结果。
**建议**：改成显式 `grp["__mv_z"].transform(lambda s: np.var(s.values, ddof=0))`，与同函数内 `ez = grp["__mv_z"].transform("mean")` 风格一致，去掉 `apply`。

### 2. `features/builder.py:332` — 市值中性化的 β 残差化未做行业内，因子定义偏离 spec
注释声称「step1 行业内 z-score，step2 减 β×mv_z」，但 step2 的 β 是**全市场截面**回归。若某行业整体偏小盘，行业中性化后再叠加全市场 mv 残差化会把「行业=小盘」信息重新混入。不是前视偏差，但当前实现得到的不是干净的「行业内+市值内」残差。
**建议**：要么做真正的多元 OLS（行业哑变量 + mv_log），要么文档明确这是「近似」并接受偏差。

### 3. `features/builder.py:402-407` — 整列因子算不出来时被静默填 0 进训练矩阵
若某因子整截面全 NaN，`mu`/`sd` 为 NaN，z-score 的 `safe` 分支判 False → 整列被静默填 0，不会触发步骤⑦的 dropna。一个完全没算出来的因子以「全 0 常数列」进入训练矩阵，无人察觉。违反 CLAUDE.md「空数据不得静默跳过」。
**建议**：builder 末尾对「整列截面恒为 0/NaN 的因子」显式 `logger.warning` 并考虑剔除该因子列。

## 🟡 中等

### 4. `factors/runner.py:418` — `_upsert_daily_factors` 每日单独 upsert 未捕获异常
中途 DB 抖动会中断整个 `run_factors`，已写入日期的 progress 不回退。
**建议**：每日 upsert 包 try/except，或让 progress 反映「已成功落库到 t」。

### 5. `factors/runner.py:221` — 后复权基准用窗口内 `max(adj_factor)`，注释声称「PIT 正确」不准确
两次不同 date_range 的 run 算出的同一 `(ts_code, trade_date)` close_adj 数值不同（基准随窗口变）。当前所有因子用比值/差分，基准约掉，安全；但注释误导。
**建议**：注释澄清——此 close_adj 仅供比值/收益率因子，不可作绝对价格用。

### 6. `factors/runner.py:304` — `_slice_window_for_factor` 对每个因子都对全 panel 做 `isin` 布尔索引切片
M 因子 × N 交易日次全表扫描，A 股 ~50 万行 panel 下达 8 亿次比较。
**建议**：在 T 循环外按 trade_date 预排序，用 `panel.loc[pd.IndexSlice[:t, :]]`（MultiIndex 切片 O(log n)）。

### 7. `factors/industry/industry_momentum_20d.py:42` 等 — 窗口不足时静默用更短窗口
窗口不足以覆盖 21 个交易日时返回空 Series，runner 层只 `series.empty: continue`。某因子某日大面积返回空（如春节后）无任何 warn。
**建议**：runner 检测「某因子某日产出行数 << universe」时 warn。

### 8. `factors/runner.py:351` — 60 日类因子的 `pit_window_days=100` 窗口裕度偏紧
`fetch_start = start - (max_window+5)` 日历日。`momentum_60d` 需 61 交易日 ≈ 89 日历日，105 勉强够；春节+国庆叠加的极端情形可能不足，导致年初若干交易日 60 日因子大面积返回 NaN 而无人察觉（见问题 7）。
**建议**：把 60 日类因子 `pit_window_days` 提到 110~120。

### 9. `features/runner.py:99` — `_load_mv_map` SELECT `total_mv`，但注释/spec 说「流通市值」
`builder.py:271` 注释写「流通市值」，SQL 取的是 `total_mv`（总市值）。Tushare `daily_basic` 流通市值列名是 `circ_mv`。**字段语义与注释矛盾**。
**建议**：确认 spec 要求哪个，统一注释/列名/变量名。

### 10. `features/builder.py:151-158` 等 4 处 — grouped z-score / clip 逻辑重复 4 次
`neutralize_by_industry`、`_standardize_cross_sectional`、`neutralize_by_industry_and_market_cap`、`winsorize_factors` 各自重写一遍，含相同的 `safe = sd.where(...)` 兜底。
**建议**：抽出 `_grouped_zscore(df, group_keys, cols)` 单一实现（问题 3 的 bug 就藏在这些副本里）。

### 11. `factors/runner.py:160-207` — `_load_industry_pit` 对每个交易日单独 SELECT，O(N) 次往返
注释自承「O(N) 次数据库查询」。`features/runner.py:_load_industry_map` 已用单条 SQL 解决同一问题。
**建议**：`factors/runner.py` 改用同样的单查询写法。

## 🟢 建议

- **12.** `factors/runner.py` 共 464 行接近 500 行硬上限，承担数据加载/复权/upsert/调度四职责。建议把 `_query_*`/`_load_*` 拆到 `factors/data_access.py`。
- **13.** `factors/registry.py:50` `_REGISTRY` 存实例而非类，base 文档说「实例」registry 注释说「类」，措辞不一。
- **14.** `factors/industry/industry_neutral_momentum.py` 与 `industry_relative_strength.py` 计算完全等价，产出两列完全共线。建议只保留一个，或 builder 做相关性去重。
- **15.** `factors/price/rsi_14.py:43` docstring 说「首值用前 14 日 SMA 初始化」，实际 `ewm` 首个有效值是纯 EMA，与教科书 Wilder RSI 不符。docstring 与实现不符。
- **16.** `features/builder.py:197` `_upsert_feature_matrix` 用 `matrix.iterrows()` 逐行构 dict，百万行级极慢。改 `to_dict("records")` 或向量化。
- **17.** `features/runner.py:269` `industry_map`/`mv_map` 为空时只在 builder 内部 warn 一次，job 整体「成功」。建议在 runner 层把「industry_map 为空」作为独立 warn 透出到 job 结果。

## 总评

因子库 PIT 框架设计严谨（live_universe 过滤、index_member 按 in/out_date 快照、复权基准窗口口径都有清醒注释），**未发现真正的前视偏差**。主要风险集中在「窗口裕度偏紧导致 60 日因子年初大面积静默返 NaN」（问题 7、8）、「整列算不出来时被静默填 0 而非剔除」（问题 3）、`groupby.apply` 在新版 pandas 下的脆弱性（问题 1）——这三类会污染训练数据却不报警，应优先修复。
