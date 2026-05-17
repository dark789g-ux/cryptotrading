# KlineChart 副图根治重构：从"两数组按 key 对齐"到"单数组按行内嵌" 设计

- **日期**：2026-05-17
- **作者**：renmaoyuan（with Claude）
- **状态**：待评审
- **前置 spec**：[`2026-05-17-a-share-detail-moneyflow-subchart-design.md`](./2026-05-17-a-share-detail-moneyflow-subchart-design.md)（A 股副图接入 + 一次格式对齐 fix）

## 1. 背景与目标

前置 spec 完成 A 股 Drawer 接入副图后，发现根因层面的脆弱契约：

- `KlineChart` 副图通过 `flowMap.get(row.open_time)` 把 `moneyFlow[]` 按 `trade_date` 字符串对齐主图，**两侧必须按字面完全相等**才能命中
- 当前后端 3 个 service 的日期格式互不相同：`ths-index-daily.service.ts:93` 直返 `'YYYYMMDD'`；`a-shares.service.ts:221` 经 `formatTradeDateLabel` 转 `'YYYY-MM-DD'`；`money-flow.service.ts` 直返数据库原值 `'YYYYMMDD'`
- A 股 Drawer 首次实现时全部副图柱形画不出（grid/legend/yAxis 都渲染了，比直接报错更难发现）；前置 spec 用 fetcher 层 `toIsoTradeDate` 补丁治标，CLAUDE.md 加禁令做 process guard——**仍依赖开发者下次接副图时记住先 grep 后端**
- `klineChartTooltip.ts:135` 同样用 `moneyFlow.find(r => r.trade_date === row.open_time)` 做 key 对齐，同源脆弱点

本期目标 **R1 + R3**：

1. **R1 — 消除"两数组对齐"动作**：把 `moneyFlow` 直接挂到 `KlineChartBar.moneyFlow: number | null` 字段上，KlineChart 副图渲染按 index 读取（`data[i].moneyFlow`），不存在 miss 可能
2. **R3 — fetcher 合并层的运行时探针**：在唯一的 `mergeKlineWithMoneyFlow` helper 内部，dev 模式下检测 "flowRows 非空但合并后 0 命中" → `console.error` + 打印 sampleKlineKey / sampleFlowKey，让开发者刷一次页面就能看到具体不匹配的字符串

合并后，对齐操作收敛到 helper 一处；KlineChart 不再做 Map 查找；Tooltip 也连带根治。

## 2. 非目标

- **不动后端任何接口契约**：后端各 service 的 `open_time` / `tradeDate` 字符串格式保持现状，由前端 helper 内部 `normalizeDateKey` 统一去短横作合并 key
- **不引入 Branded Type**：保持 `string` 类型，靠 helper 集中归一化而非编译期拦截（branded types 在 `@cryptotrading/shared-types` 跨包链路下扩散面较大，工程收益边际递减）
- **不改 `klineChartLayout.ts` / `klineChartOverlay.ts`**：两者只看 `hasFlow: boolean`，与数据来源无关
- **不回改前置 spec 文档**（`2026-05-17-a-share-detail-moneyflow-subchart-design.md`）—— 已发布快照
- **不调整 CLAUDE.md 禁令**：本期重构落地后那条禁令的"先 grep 后端"建议变得弱化（merge helper 已统一处理），但仍是有效的项目纪律，留作背景知识

## 3. 架构

```
旧契约（两数组靠 trade_date === open_time 对齐，脆弱）：

  fetcher → { kline: KlineChartBar[], moneyFlow: MoneyFlowBar[] }
            ↓
  <KlineChart :data="kline" :money-flow="flow" />
                                  ↓ (flowMap.get + 格式假设)
                            副图柱形（易 miss）

新契约（单数组按行天然挂载，根治）：

  fetcher → mergeKlineWithMoneyFlow(kline, flowRows)
            ↓
  fetcher → { kline: KlineChartBar[] }   // 每根 bar 自带 row.moneyFlow
            ↓
  <KlineChart :data="klineWithFlow" />
                       ↓ (data[i].moneyFlow 直接读)
                  副图柱形（不可能错位）
```

对齐操作收敛到唯一的 `mergeKlineWithMoneyFlow` helper；KlineChart 删 `moneyFlow` prop 与 `flowMap`；Tooltip 改读 `row.moneyFlow`。

## 4. 详细设计

### 4.1 类型契约变化（`apps/web/src/api/modules/market/symbols.ts`）

```ts
export interface KlineChartBar {
  open_time: string
  // ... 现有字段全保留 ...
  brickChart?: BrickChartPoint
  trades?: TradeOnBar[]
  moneyFlow?: number | null   // 新增：单位亿元，与 brickChart / trades 同档（可选字段）
}

// MoneyFlowBar 接口整体删除（重构后无任何业务消费者）
```

`AShareKlineBar extends KlineChartBar` 自动继承，**零改动**。

### 4.2 新建 `apps/web/src/composables/kline/mergeMoneyFlow.ts`

```ts
import type { KlineChartBar } from '@/api'

/** 把任意日期字符串归一为无短横的 'YYYYMMDD'，作为合并 key。 */
function normalizeDateKey(s: string): string {
  return s.replaceAll('-', '')
}

/** 后端资金流行的最小字段需求（接受 trendFetchers / aShareDetailFetcher 的 raw 行）。 */
export interface MoneyFlowRowLike {
  tradeDate: string                 // 'YYYYMMDD'
  netAmount: string | number | null // 已由后端 toYi() 转为亿元
}

/**
 * 把资金流 raw 行合并进 K 线数组，返回挂载了 moneyFlow 字段的新 K 线数组。
 *
 * 输入 K 线数组原样保留顺序（按 trade_date ASC），不修改原对象（spread 新建）。
 *
 * @param kline K 线数组，open_time 字符串格式由各后端 service 决定
 *              （行业：'YYYYMMDD'；A 股：'YYYY-MM-DD'）
 * @param flowRows 资金流原始行（trade_date DESC 或任意顺序均可），netAmount 已是亿元
 * @returns 同构 K 线数组，每根 bar 新增 moneyFlow: number | null
 */
export function mergeKlineWithMoneyFlow<T extends KlineChartBar>(
  kline: T[],
  flowRows: MoneyFlowRowLike[],
): T[] {
  const flowMap = new Map<string, number>(
    flowRows.map(r => [normalizeDateKey(r.tradeDate), Number(r.netAmount) || 0]),
  )

  const merged = kline.map(bar => ({
    ...bar,
    moneyFlow: flowMap.get(normalizeDateKey(bar.open_time)) ?? null,
  }))

  // R3 探针：dev 模式下，flowRows 非空但合并后 0 命中 → 强烈暗示格式不一致
  if (import.meta.env.DEV && flowRows.length > 0 && kline.length > 0) {
    const matched = merged.filter(b => b.moneyFlow != null).length
    if (matched === 0) {
      console.error(
        '[mergeKlineWithMoneyFlow] 资金流非空但与 K 线 0 命中，疑似日期格式不一致。',
        {
          klineLen: kline.length,
          flowLen: flowRows.length,
          sampleKlineOpenTime: kline[0]?.open_time,
          sampleFlowTradeDate: flowRows[0]?.tradeDate,
        },
      )
    }
  }

  return merged
}
```

**R3 探针触发条件设计要点**：

| 条件 | 行为 | 设计依据 |
|---|---|---|
| `import.meta.env.DEV` | 仅 dev 模式 | 不污染生产；vite 内置 DEV 常量 |
| `flowRows.length > 0` | 跳过"无资金流"合法场景 | 北交所新股、停牌票合法返回 0 行，不该报警 |
| `kline.length > 0` | 跳过"K 线为空"边缘场景 | 避免除 0 / 假阳性 |
| `matched === 0`（严格 0 命中） | 触发 console.error | 0 命中是格式不一致的明确信号；部分命中（如新股 30 天数据 vs K 线 360 天）合法，不触发 |
| log payload | 包含 `sampleKlineOpenTime` + `sampleFlowTradeDate` | 开发者刷一次页面就能在 console 看到具体不匹配的字符串样本，定位时间 < 30s |

### 4.3 `apps/web/src/components/money-flow/money-flow.types.ts`

```ts
// 旧
export interface TrendFetchResult {
  kline: KlineChartBar[]
  moneyFlow: { trade_date: string; net_amount: number }[]
}

// 新
export interface TrendFetchResult {
  kline: KlineChartBar[]   // 已 merge moneyFlow，每根 bar 自带 row.moneyFlow
}
```

### 4.4 `apps/web/src/components/money-flow/trendFetchers.ts`

```ts
import { mergeKlineWithMoneyFlow } from '@/composables/kline/mergeMoneyFlow'

export async function fetchIndustryTrend(
  params: MoneyFlowQueryParams,
): Promise<TrendFetchResult> {
  const ranged = requireDateRange(params)
  const [kline, flowRows] = await Promise.all([
    thsIndexDailyApi.query(ranged),
    moneyFlowApi.queryIndustries(params),
  ])
  return {
    kline: mergeKlineWithMoneyFlow(kline, flowRows),
  }
}

export async function fetchSectorTrend(
  params: MoneyFlowQueryParams,
): Promise<TrendFetchResult> {
  const ranged = requireDateRange(params)
  const [kline, flowRows] = await Promise.all([
    thsIndexDailyApi.query(ranged),
    moneyFlowApi.querySectors(params),
  ])
  return {
    kline: mergeKlineWithMoneyFlow(kline, flowRows),
  }
}
```

`MoneyFlowIndustryRow` / `MoneyFlowSectorRow` 直接喂给 helper（已满足 `MoneyFlowRowLike` 结构契约：`tradeDate: string` + `netAmount: string | null`）。删除原来手写的 `flow.map(r => ({ trade_date: r.tradeDate, net_amount: Number(r.netAmount) || 0 }))` 映射。

### 4.5 `apps/web/src/components/symbols/a-shares/aShareDetailFetcher.ts`

```ts
import { aSharesApi, type AShareKlineBar } from '@/api/modules/market/aShares'
import { moneyFlowApi, type MoneyFlowStockRow } from '@/api/modules/market/moneyFlow'
import { mergeKlineWithMoneyFlow, type MoneyFlowRowLike } from '@/composables/kline/mergeMoneyFlow'

export interface AShareDetailFetchResult {
  kline: AShareKlineBar[]              // 已 merge moneyFlow
  flowRows: MoneyFlowRowLike[]         // 透出 raw，供 priceMode 切换路径复用
}

export async function fetchAShareDetail(
  tsCode: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<AShareDetailFetchResult> {
  const [kline, flowRows] = await Promise.all([
    aSharesApi.getKlines(tsCode, limit, priceMode),
    moneyFlowApi.queryStocks({ ts_code: tsCode, limit }),
  ])
  return {
    kline: mergeKlineWithMoneyFlow(kline, flowRows),
    flowRows,
  }
}

/** priceMode 切换时调用：只重拉 K 线，资金流由消费方缓存后重新 merge */
export async function fetchAShareKlineOnly(
  tsCode: string,
  limit: number,
  priceMode: 'qfq' | 'raw',
): Promise<AShareKlineBar[]> {
  return aSharesApi.getKlines(tsCode, limit, priceMode)
}
```

**删除**：`mapMoneyFlowBars` 函数（语义已被 `mergeKlineWithMoneyFlow` 覆盖）+ `toIsoTradeDate` 函数（归一化已转入 helper 内部的 `normalizeDateKey`）。

行业 / 板块 fetcher 不需要透出 `flowRows`（FlowTrendModal 无 priceMode 概念，整体重拉即可），保持 `TrendFetchResult { kline }` 简洁形态。

### 4.6 `apps/web/src/components/money-flow/FlowTrendModal.vue`

```ts
// 旧
const klineBars = ref<KlineChartBar[]>([])
const moneyFlowBars = ref<MoneyFlowBar[]>([])

async function load() {
  const r = await props.fetchFn(params)
  klineBars.value = r.kline
  moneyFlowBars.value = r.moneyFlow ?? []
}

// 新
const klineBars = ref<KlineChartBar[]>([])

async function load() {
  const r = await props.fetchFn(params)
  klineBars.value = r.kline   // 已含 moneyFlow
}
```

模板：

```vue
<!-- 旧 -->
<KlineChart :data="klineBars" :money-flow="moneyFlowBars" height="520px" />

<!-- 新 -->
<KlineChart :data="klineBars" height="520px" />
```

删除 `MoneyFlowBar` import。

### 4.7 `apps/web/src/components/symbols/a-shares/AShareDetailDrawer.vue`

```ts
import {
  fetchAShareDetail,
  fetchAShareKlineOnly,
} from './aShareDetailFetcher'
import { mergeKlineWithMoneyFlow, type MoneyFlowRowLike } from '@/composables/kline/mergeMoneyFlow'

const loading = ref(false)
const klineRows = ref<AShareKlineBar[]>([])
// 缓存最近一次的资金流 raw 行，供 priceMode 切换路径复用
const cachedFlowRows = ref<MoneyFlowRowLike[]>([])

async function loadDetail() {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  klineRows.value = []
  cachedFlowRows.value = []
  try {
    const result = await fetchAShareDetail(tsCode, 360, props.priceMode)
    klineRows.value = result.kline
    cachedFlowRows.value = result.flowRows
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

async function reloadKlineOnly() {
  const tsCode = props.row?.tsCode
  if (!tsCode) return
  loading.value = true
  try {
    const rawKline = await fetchAShareKlineOnly(tsCode, 360, props.priceMode)
    // 把缓存的资金流挂回新 K 线（开发模式下若日期格式漂移 R3 探针会触发）
    klineRows.value = mergeKlineWithMoneyFlow(rawKline, cachedFlowRows.value)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}
```

模板：

```vue
<kline-chart v-else :data="klineRows" height="100%" :slider-start="35" />
```

watch 部分（`[show, tsCode]` / `priceMode` 双 watch）结构沿用前置 spec § 4.2，不变。删除 `moneyFlowRows` ref 与 `MoneyFlowBar` import。

### 4.8 `apps/web/src/components/kline/KlineChart.vue`

```ts
// 旧 props
defineProps<{
  data: KlineChartBar[]
  currentTs?: string
  sliderStart?: number
  height?: string | number
  moneyFlow?: MoneyFlowBar[]
}>()

// 新 props
defineProps<{
  data: KlineChartBar[]
  currentTs?: string
  sliderStart?: number
  height?: string | number
}>()

// 旧
const hasFlow = Array.isArray(props.moneyFlow) && props.moneyFlow.length > 0

// 新
import { computed } from 'vue'
const hasFlow = computed(() => props.data.some(row => row.moneyFlow != null))

// 旧
buildKlineChartOption({ data: props.data, moneyFlow: props.moneyFlow, ... })
scheduleGraphicUpdate(safeIdx, data, hasFlow)

// 新
buildKlineChartOption({ data: props.data, ... })
scheduleGraphicUpdate(safeIdx, data, hasFlow.value)
```

`watch` 依赖列表删 `props.moneyFlow`（`props.data` 变化已能触发 `hasFlow` 重算）；删除 `MoneyFlowBar` import。

### 4.9 `apps/web/src/composables/kline/klineChartOptions.ts`

```ts
// 旧 BuildKlineChartOptionsParams
interface BuildKlineChartOptionsParams {
  data: KlineChartBar[]
  // ...
  moneyFlow?: MoneyFlowBar[]   // 删
}

// 新（无 moneyFlow 字段）
interface BuildKlineChartOptionsParams {
  data: KlineChartBar[]
  // ...
}

// 旧 hasFlow 计算
const hasFlow = Array.isArray(moneyFlow) && moneyFlow.length > 0

// 新
const hasFlow = data.some(row => row.moneyFlow != null)
```

副图 series 构造从 `flowMap.get` 改为 index 直接读：

```ts
// 旧（lines 267-291）
if (hasFlow) {
  const flowMap = new Map<string, number>(
    (moneyFlow as MoneyFlowBar[]).map((r) => [r.trade_date, r.net_amount]),
  )
  const flowData = data.map((row) => {
    const v = flowMap.get(row.open_time)
    if (v == null) return null
    return { value: v, itemStyle: { color: v >= 0 ? CANDLE_COLORS.up : CANDLE_COLORS.down } }
  })
  moneyFlowSeries = { name: 'FLOW', type: 'bar', xAxisIndex: 5, yAxisIndex: 5, data: flowData, barMaxWidth: 12 }
}

// 新
if (hasFlow) {
  const flowData = data.map((row) => {
    const v = row.moneyFlow
    if (v == null) return null
    return { value: v, itemStyle: { color: v >= 0 ? CANDLE_COLORS.up : CANDLE_COLORS.down } }
  })
  moneyFlowSeries = { name: 'FLOW', type: 'bar', xAxisIndex: 5, yAxisIndex: 5, data: flowData, barMaxWidth: 12 }
}
```

Tooltip 调用：

```ts
// 旧
return buildTooltip(row, idx, data, moneyFlow)

// 新
return buildTooltip(row, idx, data)
```

删除 `MoneyFlowBar` import。

### 4.10 `apps/web/src/composables/kline/klineChartTooltip.ts`

```ts
// 旧 signature
export function buildTooltip(
  row: KlineChartBar,
  idx: number,
  data: KlineChartBar[],
  moneyFlow?: MoneyFlowBar[],
) {
  // ...
  let flowHtml = ''
  if (moneyFlow && moneyFlow.length) {
    const hit = moneyFlow.find((r) => r.trade_date === row.open_time)
    if (hit) {
      const sign = hit.net_amount >= 0 ? '+' : ''
      flowHtml = `<div>资金净流入：${sign}${hit.net_amount.toFixed(2)} 亿</div>`
    }
  }
  // ...
}

// 新 signature
export function buildTooltip(
  row: KlineChartBar,
  idx: number,
  data: KlineChartBar[],
) {
  // ...
  let flowHtml = ''
  if (row.moneyFlow != null) {
    const sign = row.moneyFlow >= 0 ? '+' : ''
    flowHtml = `<div>资金净流入：${sign}${row.moneyFlow.toFixed(2)} 亿</div>`
  }
  // ...
}
```

删除 `MoneyFlowBar` import。

### 4.11 `klineChartLayout.ts` / `klineChartOverlay.ts`

**零改动**。两文件只接受 `hasFlow: boolean`，与数据来源无关。

## 5. 测试策略

### 5.1 单测变更与新增

| 文件 | 类型 | 改动 |
|---|---|---|
| `mergeMoneyFlow.spec.ts` | **新建** | 8 用例：基本合并 / 双方同格式（行业形态）/ 部分缺失 / 资金流全无 / null netAmount 回退 / 不修改原对象 / R3 探针正面（0 命中触发）/ R3 探针负面（合法 0 行不触发） |
| `klineChartOptions.spec.ts` | **重构 fixture** | 6 个 snapshot 用例 fixture 改为 `KlineChartBar.moneyFlow` 内嵌；`buildKlineChartOption` 调用删 `moneyFlow` 参数 |
| `trendFetchers.spec.ts` | **改断言** | 断言从 `result.moneyFlow[i].net_amount` 改为 `result.kline[i].moneyFlow` |
| `aShareDetailFetcher.spec.ts` | **重写大部** | 删 `mapMoneyFlowBars` / `toIsoTradeDate` 相关用例（已转入 `mergeMoneyFlow.spec.ts`）；新增 `flowRows` 透出字段断言；现有"格式对齐"与"容错"用例迁移到 `mergeMoneyFlow.spec.ts` |

### 5.2 集成回归手测

- **行业详情 Tab**：副图仍正常（重构不能破坏现有行为）
- **A 股 Drawer**：副图正常 + priceMode 切换后副图保持显示（不重发 `/money-flow/stocks`）
- **DevTools console**：dev 模式下用故意构造的不匹配 fixture 跑一遍，确认 R3 探针 `[mergeKlineWithMoneyFlow] ... 0 命中` 报警可见

### 5.3 验收命令

```powershell
pnpm --filter @cryptotrading/web exec vitest run src/composables/kline/mergeMoneyFlow.spec.ts
pnpm --filter @cryptotrading/web exec vitest run src/composables/kline/klineChartOptions.spec.ts
pnpm --filter @cryptotrading/web exec vitest run src/components/money-flow/trendFetchers.spec.ts
pnpm --filter @cryptotrading/web exec vitest run src/components/symbols/a-shares/aShareDetailFetcher.spec.ts
pnpm --filter @cryptotrading/web exec vue-tsc --noEmit
```

### 5.4 grep 反查（验证彻底性）

```powershell
rg "\bMoneyFlowBar\b" apps/web/src/
rg ":money-flow=" apps/web/src/
rg ":moneyFlow=" apps/web/src/
rg "flowMap\.get|moneyFlow\.find" apps/web/src/composables/kline/
```

四条期望命中均为 0。

## 6. 任务切分（对齐 dispatching-parallel-agents）

按"上下游依赖"切分。Task α 是其它任务的依赖前提（KlineChart 契约变化），必须先完成；β/γ 文件域不相交但都依赖 α 的新类型与新 helper。

| Task | 范围 | 依赖 | 改动 |
|---|---|---|---|
| **α — 核心契约 + helper + 渲染器** | `symbols.ts` 加字段删 `MoneyFlowBar` + 新建 `mergeMoneyFlow.ts` 与 `mergeMoneyFlow.spec.ts` + 改 `KlineChart.vue` / `klineChartOptions.ts` / `klineChartTooltip.ts` + 更新 `klineChartOptions.spec.ts` | 无 | 5 改 + 2 新建 ≈ 80 行净改动 |
| **β — fetcher 改造** | `money-flow.types.ts` + `trendFetchers.ts` + `aShareDetailFetcher.ts` + 两个 fetcher spec | α 完成 | 5 文件 ≈ 30 行净改动 |
| **γ — 消费方简化** | `FlowTrendModal.vue` + `AShareDetailDrawer.vue` | β 完成 | 2 文件 ≈ 30 行净改动 |

**派发策略**：**Task α + β 合并为一个 agent**（同 session 内完成避免跨 agent 同步等待），**Task γ 单独一个 agent**。Task α+β 完成后主会话跑一次 vue-tsc 确认编译过，再派 γ。最终 **2 个 agent 串行派发**。

**文件域非冲突**：
- α 只动 `composables/kline/*` + `KlineChart.vue` + `symbols.ts`
- β 只动 `components/money-flow/trendFetchers.ts` + `components/money-flow/money-flow.types.ts` + `components/symbols/a-shares/aShareDetailFetcher.ts` + 各自的 spec
- γ 只动两个消费方 .vue 文件
- 即使串行派发，文件域也是清晰分离的

## 7. 风险与回避

| 风险 | 回避 |
|---|---|
| `KlineChartBar.moneyFlow` 字段名与现有某处变量冲突 | grep 已确认无冲突；字段名与 `brickChart` / `trades` 风格一致 |
| AShareKlineBar 自动继承后某处类型推断意外失败 | `vue-tsc --noEmit` 兜底；α 改完立即跑确认 |
| priceMode 切换路径 cachedFlowRows 与新 K 线日期范围漂移导致部分 miss | A 股 K 线 360 天范围对同一只股票 priceMode 切换前后不变；merge helper 按 index 对齐能正确处理；如 dev 模式真出现漂移 R3 探针会兜底 |
| FlowTrendModal 通过 props.fetchFn 调用 fetcher，类型变化影响 prop 类型 | β 同步改 `TrendFetchResult`；FlowTrendModal 改在 γ；TS 编译会强制对齐 |
| snapshot 测试 6 个用例 fixture 全部要重写 | 一次性重写，TDD 顺序：先改 fixture 看红，再改实现，再看绿 |
| 删除 `MoneyFlowBar` 类型后某处遗漏 import | grep 反查 §5.4 第 1 条兜底；TS 编译会标错未删的 import |

## 8. 验收清单（写代码前公示）

1. ✅ `KlineChartBar.moneyFlow?: number | null` 字段已加，`AShareKlineBar` 自动继承
2. ✅ `MoneyFlowBar` 类型从 `symbols.ts` 删除（`rg "\bMoneyFlowBar\b" apps/web/src/` = 0）
3. ✅ `KlineChart` 组件 props 不再含 `moneyFlow`，`hasFlow` 改为 `computed(() => data.some(...))`
4. ✅ `klineChartOptions.ts` 副图 series 按 index 读 `data[i].moneyFlow`（`rg "flowMap\.get" apps/web/src/composables/kline/` = 0）
5. ✅ `klineChartTooltip.ts` 从 `row.moneyFlow` 读（`rg "moneyFlow\.find" apps/web/src/composables/kline/` = 0）
6. ✅ `mergeMoneyFlow.ts` 新建 + 8 用例单测全绿（含 R3 探针正反两面）
7. ✅ `TrendFetchResult` 改为 `{ kline }`；`AShareDetailFetchResult` 改为 `{ kline, flowRows }`
8. ✅ FlowTrendModal / AShareDetailDrawer 模板删 `:money-flow` 绑定（`rg ":money-flow=" apps/web/src/` = 0）
9. ✅ A 股 Drawer priceMode 切换后副图保持显示（DevTools Network：不重发 `/money-flow/stocks`；副图柱形不闪烁）
10. ✅ `pnpm --filter @cryptotrading/web exec vue-tsc --noEmit` exit 0
11. ✅ `klineChartOptions.spec.ts` 6 个 snapshot 用例全绿
12. ✅ 手测：行业详情 Tab 副图无回归 + A 股 Drawer 副图正常 + dev console 探针可触发（用错位 fixture 验证一次）
