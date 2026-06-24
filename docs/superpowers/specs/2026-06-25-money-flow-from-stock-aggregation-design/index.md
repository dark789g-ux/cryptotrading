# 资金流向由个股聚合改造设计

## 背景与目标

当前 A 股资金流向同步拉取 4 个 Tushare 接口：

- `moneyflow_ths`（同花顺个股）
- `moneyflow_ind_ths`（同花顺行业）
- `moneyflow_cnt_ths`（同花顺概念/板块）
- `moneyflow_mkt_dc`（东方财富大盘）

本改造目标是把数据来源**收敛到只拉 `moneyflow_ths`**，行业、概念/板块、宽基指数、全市场大盘的资金流全部通过个股资金流聚合计算。

## 核心决策

| 决策 | 结论 |
|---|---|
| 个股 → 申万行业映射 | 移除 `a_share_symbols.industry`，新增 `sw_industry_l1/2/3_code`，从 `raw.index_member` 回填 |
| 同花顺行业/概念映射 | 复用现有 `ths_member_stocks` |
| 宽基指数成分映射 | 新增 `index_weight` 表，版本链（`effective_date / expire_date`）+ 按需同步 |
| 聚合权重 | 等权，不按市值/权重加权 |
| 聚合时机 | 同步时预计算 |
| 前端消费方 | 删除独立 `/money-flow` 页面；资金流字段迁入「A 股指数」面板；A 股个股面板改为三级申万行业名称列 |

## 子文档清单

| 序号 | 文档 | 内容 |
|---|---|---|
| [01](./01-background-and-goals.md) | 背景与目标 | 现状、问题、范围、决策摘要 |
| [02](./02-data-model.md) | 数据模型变更 | `a_share_symbols`、新增 `index_weight`、新增/改造聚合表 |
| [03](./03-sync-flow.md) | 同步流程 | 一键同步 Step 2 改造、`index_weight` 版本链同步 |
| [04](./04-aggregation-logic.md) | 聚合逻辑 | 5 个维度的聚合 SQL、PIT 查询、性能优化 |
| [05](./05-api-frontend.md) | API 与前端变更 | 删除 `/money-flow`、A 股指数面板加列、A 股个股面板改行业字段 |
| [06](./06-migration-backfill.md) | 迁移与回填 | migration 文件、回填脚本、历史重算 |
| [07](./07-testing-plan.md) | 测试计划 | 后端/前端/端到端测试项 |
| [08](./08-risks-and-rollout.md) | 风险与上线 | 口径变化、数据一致性、回滚策略 |

## 阅读顺序

按序号 01 → 08 顺序阅读。实现时建议按「数据模型 → 同步流程 → 聚合逻辑 → API/前端 → 迁移回填 → 测试」推进。

## 关键口径声明

- 宽基指数资金流是「成分股资金净流入合计」这一**自定义指标**，交易所/Tushare 均无官方口径可对标。
- 行业/板块聚合后会丢失 `net_buy_amount` / `net_sell_amount` / `pct_change` / `lead_stock` 等字段（填 `NULL` 或从行情表补）。
- 全市场大盘聚合后保留 `net_amount` / `buy_lg_amount` / `buy_md_amount` / `buy_sm_amount`，但丢失东方财富原接口的 `buy_elg_amount`（超大单）和历史序列。
