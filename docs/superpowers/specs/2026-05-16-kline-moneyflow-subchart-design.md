# K 线资金流副图 & 行业/板块趋势 Tab 接入 — 设计文档

- **日期**：2026-05-16
- **状态**：待评审
- **作者**：renmaoyuan / Claude (brainstorming)
- **关联前序**：
  - `docs/superpowers/specs/2026-05-11-index-catalog-sync-design.md`（`ths_index_catalog` 目录已落地，本期作为指数 K 线的外键来源）
  - `docs/superpowers/specs/2026-05-10-money-flow-sync-progress-design.md`（`money_flow_industries` / `money_flow_sectors` 已落地）

---

## 1. 背景

Money Flow 模块当前的「行业 / 板块 详情 Modal — 趋势 Tab」只展示净流入柱状图（`FlowTrendChart.vue`）。用户希望：

1. 趋势 Tab 切换为通用 K 线组件 `KlineChart.vue`，在同一画面上看到「指数 K 线 + 资金净流入副图」。
2. 通用 K 线组件新增一个**可选**资金流副图能力，不影响现有「回测 K 线弹窗」「A 股详情抽屉」两个已用方。

行业/板块指数代码（`881xxx.TI`/`885xxx.TI`）目前**没有对应 K 线行情数据**，需要先接入 Tushare `ths_daily` 接口（覆盖申万的同花顺版本，含行业 I 与概念 N），与 `ths_index_catalog`、`money_flow_*` 的 ts_code 体系完全一致，无需任何映射。

同时本期顺带下线 Money Flow 模块的「个股 Tab」UI（后端 `money_flow_stocks` 保留，仍被 daily-review 大量依赖）。

## 2. 目标与非目标

### 目标

- T1：后端新增 `ths-index-daily` 模块——同步 Tushare `ths_daily`（仅 type=I 行业、type=N 概念）并对外提供 K 线查询 API
- T2：通用 `KlineChart.vue` 新增可选 prop `moneyFlow`，传入数据即在最底部追加一条净流入柱状副图
- T3：`FlowTrendModal.vue` 的趋势 Tab 替换为 `KlineChart`，并发拉「K 线 + 资金流」两条时序后按 trade_date 对齐渲染
- T4：删除 Money Flow 个股 Tab UI（前端组件），后端保持原状

### 非目标

- 不接入申万 `sw_daily` / 中信 `ci_daily` / 东财 `dc_daily`（与现有 ths 生态代码体系不一致，本期 YAGNI）
- 不为个股 K 线增加资金流副图（个股 Tab 已下线，`AShareDetailDrawer` 是否要加是另一产品决策）
- 不动后端 `money_flow_stocks` 表、`syncStocks()`、`MoneyFlowService.queryStocks`、daily-review 相关 handler
- 不删 `FlowTrendChart.vue`（大盘 Tab 仍在用）

## 3. 任务流水线

```
┌────────────────────────────────────────────┐
│  T1 后端模块 + 同步入口                       │  ──┐
│  文件域 (后端):                              │   │
│   apps/server/src/market-data/               │   │
│     ths-index-daily/**                      │   │
│   apps/server/src/indicators/** (抽/补纯函数) │   │
│   apps/server/src/market-data/               │   │
│     market-data.module.ts (注册新模块)        │   │
│  文件域 (前端，T1 末端):                      │   │
│   apps/web/src/views/sync/SyncView.vue       │   │
│     (新增同步卡片配置；与 T2/T3/T4 不相交)     │   │
└────────────────────────────────────────────┘   │
                                                  │
┌────────────────────────────────────────────┐   │
│  T2 前端 - KlineChart 加 moneyFlow 副图      │   │ 合流
│  文件域: apps/web/src/components/kline/**    │ ──┤
│         apps/web/src/composables/kline/**    │   │
│         apps/web/src/api/modules/market/     │   │
│           symbols.ts (扩 MoneyFlowBar 类型)  │   │
└────────────────────────────────────────────┘   │
                                                  ▼
                          ┌──────────────────────────────────┐
                          │  T3 前端 - Trend Tab 切组件         │
                          │  文件域:                           │
                          │   apps/web/src/components/         │
                          │     money-flow/FlowTrendModal.vue  │
                          │     money-flow/FlowDateControl.vue │
                          │     money-flow/IndustryFlowPanel.vue│
                          │     money-flow/SectorFlowPanel.vue │
                          │   apps/web/src/api/modules/market/ │
                          │     thsIndexDaily.ts (新增)        │
                          │  blockedBy: T1, T2                 │
                          └──────────────────────────────────┘

┌────────────────────────────────────────────┐
│  T4 前端 - Money Flow 个股 Tab 下线           │   与 T1/T2/T3 并行
│  文件域:                                     │   (文件不相交)
│   apps/web/src/views/market/MoneyFlowView.vue│
│   apps/web/src/components/money-flow/        │
│     StockFlowPanel.vue (delete)              │
└────────────────────────────────────────────┘
```

**并行性**：T1 / T2 / T4 文件域两两不相交，可由 `dispatching-parallel-agents` 同时派发；T3 是串行收尾。

---

## 4. T1 — 后端 `ths-index-daily` 模块

### 4.1 表设计

照搬 A 股「quotes + indicators 双表」结构。

#### `ths_index_daily_quotes`

| 列 | 类型 | 说明 |
|---|---|---|
| `id` | bigint PK | — |
| `ts_code` | varchar | 同花顺指数代码，形如 `881101.TI` |
| `trade_date` | varchar(8) | `YYYYMMDD` |
| `open` / `high` / `low` / `close` | double | 点位 |
| `pre_close` | double | 昨日收盘点位 |
| `change` | double | 涨跌点位 |
| `pct_change` | double | 涨跌幅（百分点原值） |
| `vol_hand` | double | 成交量，单位「手」（Tushare 原始单位，不换算） |
| `total_mv_wan` | numeric(20,4) | 总市值，Tushare 原值「元」÷10000 落库 |
| `float_mv_wan` | numeric(20,4) | 流通市值，同上 |
| `turnover_rate` | double | 换手率 |
| `updated_at` | timestamptz | — |

**约束**：`UNIQUE (ts_code, trade_date)`；索引 `(ts_code, trade_date DESC)`。

> Tushare `ths_daily` **没有 `amount` 字段**——不造假成交额。前端若需"成交额"则后续单独取 `moneyflow_cnt_ths.amount`。

#### `ths_index_daily_indicators`

与 `a_share_daily_indicators` 列对齐**子集**，去掉个股交易专用项（ATR / quote_volume_10 / stop_loss_pct / risk_reward_ratio / low_9 / high_9 / loss_atr_14）：

| 列 | 类型 |
|---|---|
| `id` | bigint PK |
| `ts_code` / `trade_date` | varchar |
| `ma5` / `ma30` / `ma60` / `ma120` / `ma240` | double |
| `dif` / `dea` / `macd` | double |
| `kdj_k` / `kdj_d` / `kdj_j` | double |
| `bbi` | double |
| `brick` / `brick_delta` / `brick_xg` | double / double / boolean |
| `updated_at` | timestamptz |

**约束**：`UNIQUE (ts_code, trade_date)`。

**BRICK 在指数场景仍计算**：`calcBrickChartPoints` 只依赖 `{high, low, close}`，对指数同样适用，对"行业是否进入趋势"有信号价值。

### 4.2 同步服务

目录结构：

```
apps/server/src/market-data/ths-index-daily/
├── ths-index-daily-sync.service.ts
├── ths-index-daily-sync.controller.ts        # SSE: GET /ths-index-daily/sync/run
├── ths-index-daily-indicator.service.ts      # 指标计算
├── ths-index-daily.service.ts                # 查询
├── ths-index-daily.controller.ts             # GET /ths-index-daily
├── ths-index-daily.module.ts
└── dto/
    ├── sync.dto.ts
    └── query.dto.ts
```

**同步算法**：

1. 入参 `{ start_date, end_date, mode: 'full' | 'incremental', types?: ('I'|'N')[] }`，默认 `types=['I','N']`
2. 增量模式：调用 `filterExistingDates()`（复用 `money-flow-sync.helpers.ts`）跳过已同步交易日
3. **按 trade_date 循环**调用 `ths_daily(trade_date=YYYYMMDD)`——单日全市场返回，I+N 合计约 ~700 行，远低于 3000 上限
4. 单日响应处理：
   - `payload.data === null` → `logger.warn('apiName=ths_daily empty, params=…')`（硬约束分支 1）
   - `payload.data.items.length === 0` → `logger.warn(...)` 并 `failedItems.push({ apiName: 'ths_daily_empty', params: { trade_date } })`（硬约束分支 2）
   - 正常返回 → 字段映射 + 单位换算（`total_mv` / `float_mv` ÷10000）
5. 用 `ths_index_catalog` 过滤 ts_code（只保留 I+N），其它 type 静默丢弃
6. `batchUpsert(quotesRepo, entities, ['tsCode','tradeDate'])`，按 conflictKeys 去重保留最后一条；重复条目 `logger.warn` 含原始/去重条数
7. 当日 quotes 落库成功后，按受影响 ts_code 触发增量指标计算：
   - 取该 ts_code 最近 240 个交易日的 quotes（满足 MA240 窗口）
   - 调用 `IndicatorMathService`（见 §4.3）算 MA / KDJ / MACD / BBI / BRICK
   - upsert 到 `ths_index_daily_indicators`
8. 通过 RxJS `Subject` 发 SSE 进度事件（progress / done / error），事件 schema 与 `money-flow-sync.service.ts` 一致

**返回响应体**：

```ts
{
  success: number              // 落库 quote 行数
  failed: number
  errors: Array<{ apiName, params, message? }>   // 含 ths_daily_empty
}
```

### 4.3 指标计算复用

`a_share_daily_indicators` 的 MA / MACD / KDJ / BBI 数学函数当前位于 `a-shares-indicator.service.ts` 内部，本期需要：

- 将纯函数（不依赖 entity）抽到 `apps/server/src/indicators/`（与已存在的 `brick-chart.ts` 同目录）：
  - `apps/server/src/indicators/moving-average.ts`
  - `apps/server/src/indicators/macd.ts`
  - `apps/server/src/indicators/kdj.ts`
  - `apps/server/src/indicators/bbi.ts`
- 若现有 a-shares 实现耦合 entity，**最小侵入**：在 ths-index-daily 内复制一份纯函数，注 `// TODO: 后续与 a-shares-indicator 合并到 indicators/`，**不在本期重构 a-shares**
- BRICK 直接复用 `apps/server/src/indicators/brick-chart.ts` 现有导出

### 4.4 查询 API

**端点**：`GET /ths-index-daily?ts_code=881101.TI&start_date=20260101&end_date=20260516`

**SQL**：quotes LEFT JOIN indicators by `(ts_code, trade_date)`，按 `trade_date ASC` 排序。

**返回**：`KlineChartBar[]`（与 A 股 `aSharesApi.getKlines()` 字段契约对齐）

```ts
[
  {
    open_time: '20260516',              // trade_date 原样
    open, high, low, close,
    volume: vol_hand * 100,             // 落库存"手"，输出转"股"对齐 KlineChartBar.volume
    MA5, MA30, MA60, MA120, MA240,      // null 容忍
    'KDJ.K': …, 'KDJ.D': …, 'KDJ.J': …,
    DIF, DEA, MACD,
    BBI,
    brickChart: { brick, delta, xg } | undefined,
    // trades 不传
  },
  …
]
```

**空数据处理**：未同步指数 → 返回 `[]`，前端 Modal 显示空状态文案。

### 4.5 同步入口

- 注册到 `MarketDataModule`
- `SyncView.vue` 的 sync 配置卡片新增「指数日线 (ths_daily)」开关——本期由 T1 自行加上，因为属于后端模块自带前端入口，不与 T3 文件冲突（动 `apps/web/src/views/sync/SyncView.vue` 是 T1 任务范围内的延伸文件）

> **文件域注意**：T1 触及 `SyncView.vue` 一行级别（新增同步卡片配置）。T4 不动 `SyncView.vue`。T2/T3 也不动。冲突风险为零。

---

## 5. T2 — KlineChart `moneyFlow` 副图

### 5.1 类型扩展

`apps/web/src/api/modules/market/symbols.ts`（或新建 `kline-types.ts`）：

```ts
export interface MoneyFlowBar {
  trade_date: string   // 'YYYYMMDD'，与 KlineChartBar.open_time 同源
  net_amount: number   // 单位亿元（后端 toYi() 已转）
}
```

### 5.2 组件 API 增量

```ts
// apps/web/src/components/kline/KlineChart.vue
defineProps<{
  data: KlineChartBar[]
  currentTs?: string
  sliderStart?: number
  height?: string | number
  moneyFlow?: MoneyFlowBar[]   // 新增：undefined → 副图不渲染
}>()
```

### 5.3 ECharts 配置改造

改 `apps/web/src/composables/kline/klineChartOptions.ts`：

1. 函数签名增 `moneyFlow?: MoneyFlowBar[]`
2. **`moneyFlow` 缺失时**：grid / xAxis / yAxis / series 数量与改造前**完全一致**（snapshot 回归测试用例）
3. **`moneyFlow` 存在时**：
   - 在 5 条现有 grid 之后追加第 6 条（最底部），高度 `8%`
   - 同步追加 1 条 xAxis（gridIndex=5, category, axisLabel.show=false）+ 1 条 yAxis（gridIndex=5, name='资金净流入(亿)', scale=true）
   - 追加 1 条 BarSeriesOption（xAxisIndex=5, yAxisIndex=5）
   - 数据装配：

     ```ts
     const flowMap = new Map(moneyFlow.map(r => [r.trade_date, r.net_amount]))
     const flowData = data.map(row => {
       const v = flowMap.get(row.open_time)
       if (v == null) return null              // 缺失日期不画
       return {
         value: v,
         itemStyle: { color: v >= 0 ? CANDLE_COLORS.up : CANDLE_COLORS.down }
       }
     })
     ```

   - 主图 / 其它副图整体高度按比例略压缩（K 线 50%→45%，VOL/KDJ/MACD 12%→10%，BRICK 8%→7%，资金 10%）。**实际百分比在实现时按视觉效果微调，不写死在 spec 中**
4. **dataZoom 联动**：现有 `dataZoom.xAxisIndex: [0,1,2,3,4]` 扩为 `[0,1,2,3,4,5]`（仅在 moneyFlow 存在时）

### 5.4 Tooltip 改造

改 `apps/web/src/composables/kline/klineChartTooltip.ts`：在 K 线 / VOL / KDJ / MACD 行之后追加：

```
资金净流入：+12.34 亿  (绿色) / -5.67 亿 (红色)
```

- 仅当 `moneyFlow` 当 bar 命中时显示该行
- 颜色与柱体一致（`CANDLE_COLORS.up` / `down`）

### 5.5 影响审计

| 引用方 | 是否传 `moneyFlow` |
|---|---|
| `KlineChartModal.vue`（回测） | 否（零变化） |
| `AShareDetailDrawer.vue`（A 股详情） | 否（零变化） |
| `CandleRunSymbolMetrics.vue` | 否（零变化） |
| `FlowTrendModal.vue`（T3 引入） | 是 |

---

## 6. T3 — Trend Tab 切组件

### 6.1 新增前端 API 客户端

`apps/web/src/api/modules/market/thsIndexDaily.ts`：

```ts
import { request } from '@/api/_shared/http'
import type { KlineChartBar } from './symbols'

export interface ThsIndexDailyQuery {
  ts_code: string
  start_date: string
  end_date: string
}

const API_BASE = '/api'

export const thsIndexDailyApi = {
  query: (params: ThsIndexDailyQuery) =>
    request<KlineChartBar[]>(
      `${API_BASE}/ths-index-daily?ts_code=${params.ts_code}` +
        `&start_date=${params.start_date}&end_date=${params.end_date}`
    ),
}
```

### 6.2 `IndustryFlowPanel.vue` / `SectorFlowPanel.vue` 的 fetchFn 改造

引入新返回类型：

```ts
// apps/web/src/components/money-flow/money-flow.types.ts
export interface TrendFetchResult {
  kline: KlineChartBar[]
  moneyFlow: MoneyFlowBar[]
}
```

修改 fetchFn 签名：`Promise<BarChartRow[]>` → `Promise<TrendFetchResult>`：

```ts
async function trendFetchFn(params: MoneyFlowQueryParams): Promise<TrendFetchResult> {
  const [kline, flow] = await Promise.all([
    thsIndexDailyApi.query({
      ts_code: params.ts_code!,
      start_date: params.start_date!,
      end_date: params.end_date!,
    }),
    moneyFlowApi.queryIndustries(params),     // SectorFlowPanel 改 querySectors
  ])
  return {
    kline,
    moneyFlow: flow.map(r => ({
      trade_date: r.tradeDate,
      net_amount: Number(r.netAmount) || 0,
    })),
  }
}
```

### 6.3 `FlowTrendModal.vue` 双模式改造

`FlowTrendModal` 现状被 `MarketFlowPanel` / `IndustryFlowPanel` / `SectorFlowPanel` **三方共用**（个股已 T4 下线）。三者数据形态不同：

- **大盘**：无 K 线，沿用 `BarChartRow[]` + `FlowTrendChart`
- **行业 / 板块**：K 线 + 资金流，用 `TrendFetchResult` + `KlineChart`

通过新增 `chartMode` prop 分支渲染：

```ts
defineProps<{
  // …existing props
  chartMode: 'bar' | 'kline'    // 默认 'bar'，保持大盘 Panel 向后兼容
  fetchFn: ChartMode extends 'bar'
    ? (p: MoneyFlowQueryParams) => Promise<BarChartRow[]>
    : (p: MoneyFlowQueryParams) => Promise<TrendFetchResult>
  // 类型上用条件类型；运行时由 chartMode 决定调用约定，不靠 result 形状判别
}>()
```

模板：

```vue
<n-tab-pane name="trend" tab="趋势">
  <FlowDateControl
    :hide-mode-toggle="chartMode === 'kline'"
    default-mode="range"
    :default-range-days="chartMode === 'kline' ? 120 : 30"
    @change="onDateChange"
  />
  <n-spin v-if="loading" />
  <template v-else-if="chartMode === 'bar'">
    <FlowTrendChart :rows="barRows" />
  </template>
  <template v-else>
    <div v-if="!klineBars.length" class="empty-state">
      该指数暂无 K 线数据，可能尚未同步
    </div>
    <KlineChart v-else :data="klineBars" :money-flow="moneyFlowBars" height="520px" />
  </template>
</n-tab-pane>
```

状态分桶：

```ts
const barRows = ref<BarChartRow[]>([])              // 仅 chartMode === 'bar' 用
const klineBars = ref<KlineChartBar[]>([])          // 仅 chartMode === 'kline' 用
const moneyFlowBars = ref<MoneyFlowBar[]>([])       // 仅 chartMode === 'kline' 用

async function loadTrend(params: MoneyFlowQueryParams) {
  loading.value = true
  try {
    const result = await props.fetchFn(params)
    if (props.chartMode === 'bar') {
      barRows.value = result as BarChartRow[]
    } else {
      const r = result as TrendFetchResult
      klineBars.value = r.kline
      moneyFlowBars.value = r.moneyFlow
    }
  } finally {
    loading.value = false
  }
}
```

**Panel 调用方更新**：

- `MarketFlowPanel.vue`：传 `chart-mode="bar"`，fetchFn 不变（返回 `BarChartRow[]`）
- `IndustryFlowPanel.vue` / `SectorFlowPanel.vue`：传 `chart-mode="kline"`，fetchFn 改为返回 `TrendFetchResult`（见 §6.2）

### 6.4 `FlowDateControl.vue` 增量

新增 prop：

```ts
defineProps<{
  hideModeToggle?: boolean    // 默认 false，向后兼容
  // …existing props
}>()
```

`hideModeToggle === true` 时不渲染"单日/范围"切换按钮组，组件内部 `mode` 强制 `'range'`。

### 6.5 默认范围调整

`default-range-days` 改为 `chartMode === 'kline' ? 120 : 30`（见 §6.3 模板）。

理由：K 线场景需要更长窗口让 MA60 / MACD 形态成形；大盘 Tab 仍保留 30 天默认。

---

## 7. T4 — Money Flow 个股 Tab 下线

### 7.1 改动

1. `apps/web/src/views/market/MoneyFlowView.vue`：
   - 删除 `<n-tab-pane name="stocks" tab="个股">…</n-tab-pane>` 整块
   - 删除 `import StockFlowPanel from '@/components/money-flow/StockFlowPanel.vue'`
   - 若 `defaultTab` 当前是 `'stocks'`，改为 `'industries'`
2. `git rm apps/web/src/components/money-flow/StockFlowPanel.vue`

### 7.2 不动的资源

- 后端 `GET /money-flow/stocks` 控制器、`MoneyFlowService.queryStocks`、`money_flow_stocks` 表 / entity、`syncStocks()` 同步任务、`SyncView` 个股开关
- 前端 `moneyFlowApi.queryStocks` 函数（零成本保留，便于未来恢复）
- `shared-types/MoneyFlowStockRow` 类型
- daily-review 的 `snapshot-builder` / `fetch-top-list` / `lookup-stock` / `lookup-concept` 等所有 handler

### 7.3 验证

- 打开 Money Flow 页面 → 看到 3 个 Tab（大盘 / 行业 / 板块），无个股
- daily-review 报告生成正常（回归）

---

## 8. 错误处理与边界

| 风险 | 处理 |
|---|---|
| Tushare `ths_daily` 当日 0 行 | T1 显式 `failedItems.push({ apiName: 'ths_daily_empty', params })`，UI sync 面板可见 |
| Tushare 返回重复 (ts_code, trade_date) | T1 按 conflictKeys 去重 + `logger.warn` 原始/去重行数 |
| K 线 与 money_flow 日期错位（停牌 / Tushare 延迟） | 前端按 `trade_date` Map 对齐；缺失方不画该 bar（§5.3） |
| 用户切到未同步的 ts_code | Modal 兜底空状态文案（§6.3） |
| ths_daily 6000 积分门槛 | 用户当前 7000，余量较低；若降积分须降级 sw_daily（仅行业，无概念） |
| MA240 / MACD 等指标在指数早期日期窗口不足 | 后端预算时窗口不足返回 null；前端 KlineChart 已容忍 null |
| 增量同步指标的窗口回看 | 取最近 240 个交易日，与 a-shares-indicator 增量策略一致 |

---

## 9. 测试策略

### 9.1 后端

- **`ths-index-daily-sync.service.spec.ts`**：
  - mock `pro_api`，验证 `ths_daily` 入参 / 出参字段映射
  - 单位换算：`total_mv` (元) ÷10000 → `total_mv_wan`；`vol` 不换算
  - 空响应分支：`data===null` 与 `items.length===0` 两条独立 `logger.warn` + `failedItems` 推送
  - 重复 (ts_code, trade_date) 去重保留最后一条 + warn
  - `// TODO: 需集成测试验证 API 契约`（按硬约束注释 mock 单测局限）
- **`ths-index-daily-indicator.service.spec.ts`**：
  - 给定 OHLC 序列 → MA / MACD / KDJ / BBI / BRICK 输出与 a-shares-indicator 同样输入的输出一致（核心数学等价性）
- **`ths-index-daily.service.spec.ts`**：
  - 查询 API JOIN 行为：indicators 缺失时返回 null 字段
  - 排序：`trade_date ASC`
- **集成测试**（按硬约束）：
  - 跑一次 30 个交易日同步，断言 `count(quotes) === count(indicators)`（行级对齐）
  - 断言所有行 OHLC 非 NULL（行级硬约束）

### 9.2 前端

- **`klineChartOptions.spec.ts`**：
  - 无 `moneyFlow` → series / yAxis / grid 数量与现状完全一致（snapshot）
  - 有 `moneyFlow` 且全命中 → 多一条 series / yAxis / grid
  - 有 `moneyFlow` 部分日期缺失 → 缺失日期 `data[i] === null`
  - `moneyFlow` 顺序乱序 → 仍按 trade_date 对齐
  - dataZoom `xAxisIndex` 数组在有 `moneyFlow` 时包含 5
- **`IndustryFlowPanel.spec.ts`**：
  - mock 两个 API，断言 `Promise.all` 并发 + 合并字段命名
- **手动 / E2E 验证清单**：
  - 行业 Modal（`881101.TI`）趋势 Tab 渲染 K 线 + 资金副图
  - 板块 Modal（`885311.TI`）同上
  - 大盘 Tab 仍是柱状图（回归）
  - 个股 Tab 不再出现
  - FlowDateControl 单日按钮不显示
  - 拖动 dataZoom 滑块，6 条轴同步缩放
  - 切到一个没数据的 ts_code，看到空状态文案

---

## 10. 不在本期改的事

- 接入 `sw_daily` / `ci_daily` / `dc_daily`
- 个股 K 线（`AShareDetailDrawer`）加资金流副图
- 大盘 K 线（无对应 ths_daily 代码）
- `FlowTrendChart.vue` 组件删除（大盘 Tab 仍在用）
- 后端 `money_flow_stocks` / `MoneyFlowService.queryStocks` / `syncStocks()` 相关清理
- a-shares-indicator 与新建 indicators/ 目录的最终合并（本期最小侵入复制一份纯函数，留 `// TODO`）

---

## 11. 验收清单

- [ ] T1：`ths_daily` 全量同步过 90 个交易日，`count(quotes) >= count(indicators)`，行级 OHLC 全非 NULL
- [ ] T1：sync 失败场景在 UI 上能看到 `ths_daily_empty` failedItem
- [ ] T2：KlineChart 现有三个引用方（回测 Modal / A 股 Drawer / Symbol Metrics）零回归
- [ ] T2：传入 `moneyFlow` 后副图正确渲染，正绿负红，缺失日期不画
- [ ] T3：行业 / 板块 Modal 趋势 Tab 显示 K 线 + 资金副图，dataZoom 联动
- [ ] T3：空数据 ts_code 走兜底文案
- [ ] T4：Money Flow 页面仅大盘 / 行业 / 板块 3 个 Tab
- [ ] T4：daily-review 报告生成回归通过
