# Money Flow 行业/板块/个股 — 净流入趋势详情 Modal

## 背景

Money Flow 页面的「大盘」Tab 已有 `FlowTrendChart` 展示净流入趋势柱状图。现需在「行业」「板块」「个股」三个 Tab 的表格中增加「操作」列，点击「详情」弹出 Modal，展示该行数据对应的净流入历史趋势图。

## 目标

- 在 IndustryFlowPanel、SectorFlowPanel、StockFlowPanel 表格末尾增加「操作」列
- 点击「详情」打开 Modal，内含独立 `FlowDateControl`（range 模式）+ `FlowTrendChart`
- 默认展示最近 30 个交易日趋势
- 用户可在 Modal 内切换日期范围

## 现有代码结构

| 文件 | 作用 |
|------|------|
| `FlowTrendChart.vue` | ECharts 柱状图，props: `rows: BarChartRow[]` |
| `FlowDateControl.vue` | 日期选择器，支持单日/区间模式 |
| `FlowBarChart.vue` | 纯 CSS 横向条形图（本次不使用） |
| `AppModal.vue` | 通用 Modal 封装（项目规范要求复用） |
| `moneyFlowApi` | 前端 API 模块，已有 `queryIndustries` / `querySectors` / `queryStocks` |
| `MoneyFlowService` | 后端 service，`queryIndustries` / `querySectors` 尚不支持 `ts_code` 过滤 |

## 设计

### 1. 后端：扩展 ts_code 过滤

**文件**: `apps/server/src/market-data/money-flow/money-flow.service.ts`

`queryIndustries` 和 `querySectors` 方法增加 `ts_code` 过滤（与 `queryStocks` 一致）：

```ts
// queryIndustries
if (dto.ts_code) {
  qb.andWhere('i.ts_code = :ts', { ts: dto.ts_code });
}

// querySectors
if (dto.ts_code) {
  qb.andWhere('s.ts_code = :ts', { ts: dto.ts_code });
}
```

**文件**: `apps/server/src/market-data/money-flow/dto/query-flow.dto.ts`

更新注释，`ts_code` 不再限于个股查询。

### 2. 前端：新建 FlowTrendModal 组件

**文件**: `apps/web/src/components/money-flow/FlowTrendModal.vue`

```
FlowTrendModal
├── AppModal
│   ├── #default: FlowDateControl (range 模式, defaultRangeDays=30) + FlowTrendChart
│   └── #actions: 关闭按钮
```

**Props**:
- `visible: boolean` — 控制显示
- `tsCode: string` — 实体标识（行业 tsCode / 板块 tsCode / 股票代码）
- `entityName: string` — 显示标题（行业名 / 板块名 / 股票名）
- `fetchFn: (params: MoneyFlowQueryParams) => Promise<BarChartRow[]>` — 数据获取回调

**行为**:
- 打开时自动加载最近 30 天数据
- FlowDateControl 切换日期时重新请求
- 关闭时重置状态

### 3. 前端：三个 Panel 表格加「操作」列

**IndustryFlowPanel.vue / SectorFlowPanel.vue / StockFlowPanel.vue**:

- `columns` 数组末尾追加操作列：
  ```ts
  {
    title: '操作',
    key: 'action',
    width: 70,
    render: (row) => h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row) }, () => '详情'),
  }
  ```
- 新增响应式变量：`trendVisible`、`trendTsCode`、`trendEntityName`
- 新增 `openDetail(row)` 函数设置上述变量
- 模板中引入 `<FlowTrendModal>` 组件

**各 Panel 的 fetchFn 映射**:

| Panel | fetchFn | tsCode 来源 | entityName 来源 |
|-------|---------|------------|----------------|
| Industry | `moneyFlowApi.queryIndustries` | `row.tsCode` | `row.industry` |
| Sector | `moneyFlowApi.querySectors` | `row.tsCode` | `row.sector` |
| Stock | `moneyFlowApi.queryStocks` | `row.tsCode` | `row.name ?? row.tsCode` |

**数据转换**: `fetchFn` 由各 Panel 提供，内部调用 API 后转换为 `BarChartRow[]`：
```ts
// IndustryPanel 示例
const fetchFn = async (params: MoneyFlowQueryParams) => {
  const rows = await moneyFlowApi.queryIndustries(params)
  return rows.map(r => ({ label: r.tradeDate, value: Number(r.netAmount) || 0 }))
}
```

### 4. 类型扩展

**文件**: `apps/web/src/components/money-flow/money-flow.types.ts`

无需新增类型，复用现有 `BarChartRow`。

## 不做的事

- Modal 内不加 KPI 卡片，仅展示趋势图
- 不修改 MarketFlowPanel
- 不新建后端接口，复用现有查询 API
