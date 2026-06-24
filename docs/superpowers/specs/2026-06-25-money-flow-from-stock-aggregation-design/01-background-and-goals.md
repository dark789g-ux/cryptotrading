# 01 背景与目标

## 现状

当前 A 股资金流向模块同步 4 个 Tushare 接口：

| 接口 | 维度 | 来源 | 金额单位 |
|---|---|---|---|
| `moneyflow_ths` | 个股 | 同花顺 | 万元 |
| `moneyflow_ind_ths` | 行业 | 同花顺 | 亿元 |
| `moneyflow_cnt_ths` | 概念/板块 | 同花顺 | 亿元 |
| `moneyflow_mkt_dc` | 大盘 | 东方财富 | 元 |

后三者本质上都是某类「聚合口径」的资金流。如果个股资金流已经包含最细粒度数据，理论上可以通过成分股映射聚合出上层维度。

## 问题

1. **数据来源不统一**：大盘资金流来自东方财富，其余来自同花顺，大小单定义、金额单位均不同。
2. **字段口径混乱**：行业/板块有 `net_buy/net_sell` 拆分，个股没有；大盘有超大单，个股没有。
3. **行业映射不标准**：`a_share_symbols.industry` 是 Tushare `stock_basic` 返回的字符串，与申万/同花顺指数目录无法稳定对齐（本库实测 75% 对不上 `sw_index_catalog`）。
4. **前端页面孤立**：`/money-flow` 页面独立存在，但消费方有限，维护成本高。

## 目标

1. 只拉取 `moneyflow_ths`，其余维度由个股聚合。
2. 统一资金流数据来源为同花顺口径。
3. 用申万三级行业结构替换 `a_share_symbols.industry`。
4. 删除独立 `/money-flow` 页面，把资金流字段迁入「A 股指数」面板。
5. A 股个股面板行业字段改为「申万一级/二级/三级行业」。

## 范围

### 包含

- `moneyflow_ths` 个股资金流同步（保留）。
- 申万三级行业资金流聚合（`raw.index_member` 映射）。
- 同花顺行业/概念资金流聚合（`ths_member_stocks` 映射）。
- 宽基指数资金流聚合（新增 `index_weight` 版本链映射）。
- 全市场大盘资金流聚合（全部 A 股加总）。
- `a_share_symbols` 表改造。
- 前端 A 股指数面板、A 股个股面板改造。
- 复盘日报 `market.netIn` 适配（口径从东方财富大盘切到同花顺个股聚合）。
- 排查并适配所有消费 `money_flow_industries` / `money_flow_sectors` / `money_flow_market` 的后端代码。

### 不包含

- 美股、Crypto 资金流向。
- AMV（活跃市值）改造（用户明确先不做）。
- 加权聚合（本次等权）。
- 实时/查询时聚合（本次同步时预计算）。

## 关键决策摘要

| 议题 | 决策 | 理由 |
|---|---|---|
| 申万 vs 同花顺行业 | **两者都保留** | 申万 1:1 干净；同花顺行业前端已有 Panel，直接砍掉影响大 |
| 宽基指数口径 | **自定义指标** | 交易所无官方指数资金流口径；Tushare 也无相关接口 |
| `index_weight` 同步频率 | **版本链 + 按需同步** | `index_weight` 是月度数据；版本链支持未来日级扩展，日常成本低 |
| 聚合方式 | **同步时预计算** | 查询快，适合面板排序分页 |
| `/money-flow` 页面 | **删除** | 消费方少，改造成本高；字段迁入 A 股指数面板 |
| A 股个股行业字段 | **三级申万行业名称列**（`swIndustryL1Name` / `swIndustryL2Name` / `swIndustryL3Name`） | 替代原 `industry` 字符串，映射稳定 |

## 口径变化声明

改造后以下字段/口径会变化：

| 表/接口 | 变化 |
|---|---|
| `money_flow_industries` | 原同花顺行业 → 改为申万三级行业；`pct_change` / `net_buy` / `net_sell` 填 `NULL` |
| `money_flow_ths_industries`（新增） | 同花顺行业资金流；`pct_change` / `net_buy` / `net_sell` 填 `NULL` |
| `money_flow_sectors` | 同花顺概念/板块；`pct_change` / `net_buy` / `net_sell` 填 `NULL` |
| `money_flow_index`（新增） | 宽基指数资金流；等权聚合 |
| `money_flow_market` | 全市场大盘；来源从东方财富改为同花顺个股加总；丢失 `buy_elg_amount` |
| `a_share_symbols` | 删除 `industry`；新增 `sw_industry_l1/2/3_code` |
