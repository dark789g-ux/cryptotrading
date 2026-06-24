# 05 API 与前端变更

## 5.1 删除 `/money-flow` 页面

### 删除或归档

| 文件 | 操作 | 备注 |
|---|---|---|
| `apps/web/src/views/market/MoneyFlowView.vue` | 删除 | 原独立页面 |
| `apps/web/src/components/money-flow/MarketFlowPanel.vue` | 删除 | 原页面子组件 |
| `apps/web/src/components/money-flow/IndustryFlowPanel.vue` | 删除 | 原页面子组件 |
| `apps/web/src/components/money-flow/SectorFlowPanel.vue` | 删除 | 原页面子组件 |
| `apps/web/src/router/index.ts` | 删除 `/money-flow` 路由 | 确保访问 404 |
| `apps/web/src/components/layout/Sidebar.vue` | 删除「资金流向」菜单项 | 避免死链 |

### 保留并适配的文件

以下文件不删除，但需适配数据源或列字段：

| 文件 | 调整内容 |
|---|---|
| `apps/web/src/components/money-flow/FlowTrendModal.vue` | 保留；K 线副图可能复用 |
| `apps/web/src/components/money-flow/FlowTrendChart.vue` | 保留；副图展示逻辑 |
| `apps/web/src/components/money-flow/mergeMoneyFlow.ts` | 保留；如字段名不变则无需改动 |
| `apps/server/src/market-data/money-flow/money-flow-sync.service.ts` | 改造：只保留 `syncStocks`，其余维度改为聚合 |
| `apps/server/src/market-data/money-flow/money-flow.service.ts` | 改造：查询服务切换数据源 |
| `apps/server/src/market-data/money-flow/*.fetcher.ts` | 删除/合并：去掉 `moneyflow_ind_ths` / `moneyflow_cnt_ths` / `moneyflow_mkt_dc` 的 fetcher |
| `packages/shared-types/src/money-flow.ts` | 扩展：新增 `MoneyFlowIndexRow` / 同步摘要字段 |

### 完全保留（零改动）的文件

- `apps/web/src/components/money-flow/FlowTrendModal.vue` 与 `FlowTrendChart.vue` 若仅消费 `money_flow_stocks` 个股资金流，则无需改动。
- `mergeMoneyFlow.ts` 若字段映射未变（如 `net_amount` / `buy_lg_amount` 等 key 不变），则无需改动。

## 5.2 共享类型扩展

`packages/shared-types/src/money-flow.ts`：

```typescript
export interface MoneyFlowIndexRow {
  id: string
  tsCode: string
  tradeDate: string
  name: string | null
  netAmount: string | null
  buyLgAmount: string | null
  buyMdAmount: string | null
  buySmAmount: string | null
}

export interface MoneyFlowLatestDates {
  stock: string | null
  swIndustry: string | null
  thsIndustry: string | null
  sector: string | null
  market: string | null
  index: string | null
}

export interface MoneyFlowSyncSummary {
  stocks: MoneyFlowSyncResult
  swIndustries: MoneyFlowSyncResult
  thsIndustries: MoneyFlowSyncResult
  sectors: MoneyFlowSyncResult
  market: MoneyFlowSyncResult
  indices: MoneyFlowSyncResult
}
```

## 5.3 后端 API 调整

### 保留的查询接口

| 接口 | 用途 |
|---|---|
| `GET /money-flow/stocks` | K 线 FLOW 副图、复盘日报 stocksTopIn/TopOut |
| `GET /money-flow/members` | 概念/指数成分股列表 |

### 改造/新增的查询接口

| 接口 | 用途 |
|---|---|
| `POST /money-flow/industries/query` | 申万行业资金流（A 股指数面板申万区） |
| `POST /money-flow/ths-industries/query` | 同花顺行业资金流（A 股指数面板同花顺行业区） |
| `GET /money-flow/sectors` | 同花顺概念/板块资金流（A 股指数面板同花顺概念区） |
| `GET /money-flow/market` | 全市场大盘资金流（复盘日报、A 股指数面板大盘区） |
| `GET /money-flow/indices` | 宽基指数资金流（A 股指数面板大盘区） |

### 推荐合并接口（可选优化）

为减少 A 股指数面板请求数，**可选**新增一个合并查询接口：

```typescript
GET /index-daily/latest-with-money-flow?category=sw|industry|concept|market&trade_date=YYYYMMDD
```

返回指数行情 + 当日资金流合一的数据结构。

**优先级说明**：
- **P1（必须）**：保留并改造上述 5.3 中的独立查询接口，确保 A 股指数面板各 tab 能按现有模式分别请求数据。
- **P2（可选）**：合并接口作为性能优化，若实现则 A 股指数面板大盘/行业/概念 tab 可切换为单次请求；不实现也不影响功能。

## 5.4 A 股指数面板加列

在 `ASharesIndexThsPanel` 和 `ASharesIndexSwPanel` 的列定义中新增可选列：

| 列名 | key | 数据来源 |
|---|---|---|
| 净流入 | `net_amount` | `money_flow_*` 对应表 |
| 大单净流入 | `buy_lg_amount` | 同上 |
| 中单净流入 | `buy_md_amount` | 同上 |
| 小单净流入 | `buy_sm_amount` | 同上 |

列定义文件：`apps/web/src/components/symbols/a-shares-index/aSharesIndexColumns.ts`

### 涉及文件与改动

| 文件 | 改动内容 |
|---|---|
| `apps/web/src/components/symbols/a-shares-index/aSharesIndexColumns.ts` | 新增 `net_amount` / `buy_lg_amount` / `buy_md_amount` / `buy_sm_amount` 列定义，申万/同花顺分别映射到对应后端表 |
| `apps/web/src/components/symbols/a-shares-index/ASharesIndexThsPanel.vue` | 列定义引用新 money-flow 列；数据源改为 `money_flow_ths_industries` / `money_flow_sectors` / `money_flow_market` / `money_flow_index` |
| `apps/web/src/components/symbols/a-shares-index/ASharesIndexSwPanel.vue` | 列定义引用新 money-flow 列；数据源改为 `money_flow_industries` |
| `apps/web/src/components/symbols/a-shares-index/ASharesIndexPanel.vue` | 如有列设置持久化，确保新列 key 进入默认列集 |
| `apps/server/src/market-data/index-catalog/index-daily.service.ts` | 扩展查询/排序白名单，支持按 money-flow 字段排序 |
| `apps/server/src/market-data/money-flow/money-flow.service.ts` | 新增/改造 `querySwIndustries` / `queryThsIndustries` / `querySectors` / `queryMarket` / `queryIndices` |
| `apps/server/src/market-data/money-flow/money-flow.controller.ts` | 新增/改造对应 API endpoint，输出 `MoneyFlowIndexRow` / 历史序列 |

后端 sort 白名单（`IndexLatestSortField`）需要同步扩展，使这些列可远程排序。

### 同花顺指数面板数据源映射

| 类型 | 资金流来源 |
|---|---|
| `market`（大盘） | `money_flow_market`（全市场）或 `money_flow_index`（具体宽基） |
| `industry`（行业） | `money_flow_ths_industries` |
| `concept`（概念） | `money_flow_sectors` |

### 申万指数面板数据源映射

| 层级 | 资金流来源 |
|---|---|
| 一级/二级/三级 | `money_flow_industries`（按 `sw_industry_l3_code` 聚合，面板展示时按层级过滤） |

## 5.5 A 股个股面板行业字段改造

### 删除

- `industry` 列
- `industry` 筛选

### 新增

- `swIndustryL1Name`（申万一级行业）
- `swIndustryL2Name`（申万二级行业）
- `swIndustryL3Name`（申万三级行业）

### 涉及文件

- `apps/web/src/api/modules/market/aShares.ts`：类型定义
- `apps/web/src/api/modules/market/symbols.ts`：类型定义
- `apps/web/src/components/symbols/a-shares/aSharesColumns.ts`：列定义
- `apps/web/src/components/symbols/a-shares/AStockInfoFields.vue`：详情展示
- `apps/web/src/components/symbols/a-shares/AShareDetailDrawer.vue`：Drawer 标题
- `apps/web/src/components/watchlist/watchlistColumnDefs.ts`：自选列表
- `apps/web/src/components/symbols/a-shares/useASharesQuery.ts`：筛选逻辑
- `apps/web/src/components/symbols/columnGroupMeta.ts`：列分组

### 筛选框设计

建议用三个独立下拉框（或三级联动 Cascader）：

```text
申万一级 [全部 / 家用电器 / ...]
申万二级 [全部 / 白色家电 / ...]
申万三级 [全部 / 空调 / ...]
```

数据源从 `sw_index_catalog` 按层级取。

## 5.6 复盘日报适配

当前 `snapshot-builder.service.ts`：

```typescript
// industryRank 从 money_flow_industries 取 name + pct_change
// conceptRank 从 money_flow_sectors 取 name + pct_change
```

改造后资金流表不再存 `pct_change`，改为从行情表取：

```sql
-- 申万行业排名
SELECT ts_code, name, pct_change
FROM index_daily_quotes
WHERE category = 'sw' AND trade_date = $1
ORDER BY pct_change DESC LIMIT 10;

-- 同花顺概念排名
SELECT ts_code, name, pct_change
FROM index_daily_quotes
WHERE category = 'concept' AND trade_date = $1
ORDER BY pct_change DESC LIMIT 10;
```

`market.netIn` 仍从 `money_flow_market` 取。

## 5.7 同步进度展示

一键同步 Step 2「资金流向」的进度事件需要扩展：

```typescript
{
  phase: '同步指数成分股',
  phase: '同步个股资金流',
  phase: '聚合申万行业资金流',
  phase: '聚合同花顺行业资金流',
  phase: '聚合概念板块资金流',
  phase: '聚合宽基指数资金流',
  phase: '聚合全市场大盘资金流',
}
```
