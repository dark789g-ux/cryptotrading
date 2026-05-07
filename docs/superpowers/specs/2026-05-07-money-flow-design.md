# 资金流向页面设计规格

**日期**：2026-05-07  
**状态**：待实现  
**方案**：A（四 Tab 平铺）

---

## 1. 背景与目标

在现有侧边栏新增「资金流向」导航入口，展示 A 股市场四个维度的资金流向数据：大盘、行业、板块、个股。支持每日盘后手动同步数据到本地数据库，所有前端查询均通过内部 API 读取数据库，不直接调用 Tushare。

**使用场景**：
- 每日盘后扫描：哪些板块/个股有异常资金流入
- 市场全景分析：大盘 + 行业 + 板块三层联合判断市场风格
- 个股研究：查看某只股票近期资金流向趋势

---

## 2. 路由与导航

### 新增路由

```ts
{
  path: '/money-flow',
  name: 'money-flow',
  component: () => import('../views/MoneyFlowView.vue'),
  meta: { title: '资金流向' },
}
```

### 侧边栏菜单顺序

```
策略回测       (backtest)
标的筛选       (symbols)
资金流向       (money-flow)   ← 新增，图标：SwapHorizontalOutline
自选列表       (watchlists)
策略条件       (strategy-conditions)
工具           (tools)
系统设置       (settings)
```

---

## 3. 页面结构

### MoneyFlowView（页面壳）

```
页面标题：资金流向 / Money Flow
副标题：A 股资金动向监测

Tab 导航（复用 SymbolsView 同款 symbol-tabs 样式）：
  大盘  |  行业  |  板块  |  个股

<keep-alive>
  MarketFlowPanel     （大盘 Tab）
  IndustryFlowPanel   （行业 Tab）
  SectorFlowPanel     （板块 Tab）
  StockFlowPanel      （个股 Tab）
</keep-alive>
```

各 Panel 在 `onActivated` 中触发数据加载（keep-alive 规范）。

### 通用布局骨架（每个 Panel 共用）

```
┌─────────────────────────────────────────────────────┐
│  日期控制栏：[单日选择器] / [区间选择器]  切换按钮       │
├──────────┬──────────┬──────────┬────────────────────┤
│  KPI 卡片1 │  KPI 卡片2 │  KPI 卡片3 │  KPI 卡片4         │
├──────────────────────────┬────────────────────────┤
│  主图表区（左 60%）        │  排名表格（右 40%）     │
│  单日：横向柱状图           │  可排序，支持搜索       │
│  区间：折线/面积图趋势       │                       │
└──────────────────────────┴────────────────────────┘
```

### 各 Tab 具体内容

#### 大盘（MarketFlowPanel）

- **数据源**：`money_flow_market` 表（Tushare `moneyflow_dc`，DC 来源）
- **KPI**：今日净流入、主力净流入、散户净流入、沪深港通净流入
- **图表**：近 N 日大盘净流入柱状图（正值红色，负值绿色）
- **表格**：替换为多指标趋势折线图（大盘无排名维度）

#### 行业（IndustryFlowPanel）

- **数据源**：`money_flow_industry` 表（Tushare `moneyflow_industry_ths`，THS 来源）
- **KPI**：净流入最多行业 Top1、净流出最多行业 Top1、涨幅最大行业、净流入行业数量
- **图表**：单日 → 各行业净流入横向柱状图（按大小排序）；区间 → Top5 行业折线趋势
- **表格**：行业列表，列：行业名 / 净流入额 / 涨跌幅 / 主力净额 / 流入占比，可排序

#### 板块（SectorFlowPanel）

- **数据源**：`money_flow_sector` 表（Tushare `moneyflow_sector_ths`，THS 来源）
- **KPI**：净流入最多板块 Top1、净流出最多板块 Top1、活跃板块数、主力净流入合计
- **图表**：横向柱状图 / 区间折线趋势（同行业）
- **表格**：板块列表，列与行业相同

#### 个股（StockFlowPanel）

- **数据源**：`money_flow_stock` 表（Tushare `moneyflow_ths`，THS 来源）
- **KPI**：净流入最多个股 Top1、涨幅最高个股、大单净流入最多、主力控盘最强
- **图表**：Top20 个股净流入横向柱状图
- **表格**：个股列表，列：代码 / 名称 / 涨跌幅 / 净流入额 / 大单净额 / 大单占比 / 中单净额 / 小单净额
  - 支持按股票代码/名称搜索
  - 支持从自选列表快速导入筛选
  - 点击行可展开 N 日趋势迷你图

---

## 4. 数据库设计

> 所有表的 `trade_date` 存 `character varying(8)`，格式 `YYYYMMDD`。时间戳列用 `timestamptz`。

### money_flow_stock

| 列名 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| trade_date | varchar(8) | 交易日，联合唯一 |
| ts_code | varchar(16) | 股票代码，联合唯一 |
| name | varchar(32) | 股票名称 |
| pct_change | numeric | 涨跌幅 |
| latest | numeric | 最新价 |
| net_amount | numeric | 资金净流入（万元） |
| net_d5_amount | numeric | 5日主力净额（万元） |
| buy_lg_amount | numeric | 大单净流入额（万元） |
| buy_lg_amount_rate | numeric | 大单净流入占比（%） |
| buy_md_amount | numeric | 中单净流入额（万元） |
| buy_md_amount_rate | numeric | 中单净流入占比（%） |
| buy_sm_amount | numeric | 小单净流入额（万元） |
| buy_sm_amount_rate | numeric | 小单净流入占比（%） |
| created_at | timestamptz | |
| updated_at | timestamptz | |

联合唯一索引：`(ts_code, trade_date)`

### money_flow_industry

| 列名 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| trade_date | varchar(8) | 联合唯一 |
| industry | varchar(64) | 行业名称，联合唯一 |
| pct_change | numeric | 涨跌幅 |
| net_amount | numeric | 净流入额（万元） |
| buy_lg_amount | numeric | 大单净额 |
| buy_md_amount | numeric | 中单净额 |
| buy_sm_amount | numeric | 小单净额 |
| created_at | timestamptz | |
| updated_at | timestamptz | |

> 具体列名以查文档确认 `moneyflow_industry_ths` 返回字段为准。

### money_flow_sector

结构与 `money_flow_industry` 类似，`industry` 列改为 `sector`。

> 具体列名以查文档确认 `moneyflow_sector_ths` 返回字段为准。

### money_flow_market

| 列名 | 类型 | 说明 |
|------|------|------|
| id | uuid PK | |
| trade_date | varchar(8) | 唯一 |
| net_amount | numeric | 大盘净流入 |
| buy_lg_amount | numeric | 主力净额 |
| buy_sm_amount | numeric | 散户净额 |
| hk_net_amount | numeric | 沪深港通净流入 |
| created_at | timestamptz | |
| updated_at | timestamptz | |

> 具体列名以查文档确认 `moneyflow_dc` 返回字段为准。

---

## 5. 后端模块

### 目录结构

```
apps/server/src/market-data/money-flow/
├── money-flow.module.ts
├── money-flow.controller.ts          — 查询路由（公开）
├── money-flow-sync.controller.ts     — 同步路由（adminOnly）
├── money-flow.service.ts             — 从 DB 查询
├── money-flow-sync.service.ts        — Tushare 拉取 + Upsert
├── entities/
│   ├── money-flow-stock.entity.ts
│   ├── money-flow-industry.entity.ts
│   ├── money-flow-sector.entity.ts
│   └── money-flow-market.entity.ts
└── dto/
    ├── query-flow.dto.ts             — 通用查询参数（trade_date / start_date+end_date）
    └── sync-flow.dto.ts              — 同步参数（start_date, end_date）
```

### 查询 API

```
GET /api/money-flow/stocks
  ?trade_date=20260507
  或 ?start_date=20260501&end_date=20260507&ts_code=000001.SZ

GET /api/money-flow/industries
  ?trade_date=20260507
  或 ?start_date=20260501&end_date=20260507

GET /api/money-flow/sectors
  （同 industries）

GET /api/money-flow/market
  （同 industries）
```

### 同步 API（仅管理员）

```
POST /api/money-flow/sync/stocks      { "start_date": "20260501", "end_date": "20260507" }
POST /api/money-flow/sync/industries
POST /api/money-flow/sync/sectors
POST /api/money-flow/sync/market
```

同步逻辑：
1. 查文档确认接口名与参数（行业/板块/大盘三个接口在实现前必须核实）
2. 调用 Tushare，外部返回空时记 `logger.warn` 附带请求参数
3. Upsert 写入数据库（TypeORM `save` with conflict on unique index）
4. 返回 `{ success: number, skipped: number, errors: string[] }`

---

## 6. 前端组件

### 文件结构

```
apps/web/src/
├── views/
│   └── MoneyFlowView.vue
├── components/money-flow/
│   ├── MarketFlowPanel.vue
│   ├── IndustryFlowPanel.vue
│   ├── SectorFlowPanel.vue
│   ├── StockFlowPanel.vue
│   ├── FlowKpiCards.vue               — 通用 KPI 卡片行（props: items[]）
│   ├── FlowBarChart.vue               — 横向/纵向柱状图（复用）
│   └── FlowDateControl.vue            — 单日/区间切换控制栏
└── api/modules/moneyFlow.ts
```

### 状态管理规则

- 各 Panel 用 `ref` 管理本地状态
- 数据加载放在 `onActivated`（keep-alive 规范），首次挂载和切换回来均触发
- 日期状态由 `FlowDateControl` emit，Panel 接收后触发请求

### 图表库

实现时先查项目已有图表依赖，优先复用；若无则使用 CSS 柱状图或引入轻量方案，避免引入 ECharts 等重型依赖。

### 错误与空状态

| 场景 | 表现 |
|------|------|
| 数据库无数据（未同步） | 空状态提示 + 跳转「数据同步」页链接 |
| 请求失败 | `n-alert` 错误卡片，显示错误原因 |
| 加载中 | KPI 区 `n-skeleton`，表格行骨架屏 |

---

## 7. 数据同步入口

在现有「数据同步」页（`/sync`，仅管理员）新增「资金流向」分组，包含四个同步卡片，每个卡片包含：
- 日期范围选择器（默认最近一个交易日）
- 执行同步按钮
- 上次同步时间 + 同步结果摘要

---

## 8. 待实现前必须确认的事项

1. **查 Tushare 文档确认接口名**：`moneyflow_industry_ths`、`moneyflow_sector_ths`、`moneyflow_dc` 的接口名、参数名、返回字段——文档地址 `https://tushare.pro/document/2`（资金流向数据分组）
2. **积分权限**：确认这些接口的积分要求，判断当前账号是否有权限
3. **图表依赖**：实现前检查项目已有图表库，避免重复引入
