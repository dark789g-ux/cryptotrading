# 让所有 KlineChart 调用方响应工具栏日期选择器（update:range）

> 自包含交接，可整段贴给全新会话直接接手。所有 file:line 为本交接撰写时（2026-06-17，分支 main）实测，接手后以真文件为准复核。

## 一句话目标

把项目里**所有渲染 `<kline-chart>` 的调用方**都接上工具栏的日期选择器：用户选了区间，图就按区间显示；清空回到各自默认窗口。范围仅限"接日期过滤"，**不**把 us-index 的"默认只显示近 200 根"性能默认铺开（用户已明确）。

## 必须先懂的核心契约（否则会走错路）

`KlineChart`（`apps/web/src/components/kline/KlineChart.vue`）**自身从不按 range 过滤 `props.data`**：
- `range` prop 只在模板里透传给工具栏的 `n-date-picker :value`（KlineChart.vue:8 `:range="range ?? null"`）当显示值；`renderChart()` 全程只用 `props.data` 构图（KlineChart.vue:152-188），不看 range。
- 工具栏 `KlineChartToolbar.vue` 的日期选择器 `@update:value` → `emit('update:range')`（:169-171）→ KlineChart re-emit（:190-192）→ **父组件**。
- `disabledRange` 默认 `false`（KlineChart.vue:61）；其它调用方目前几乎都显式传 `disabled-range` 把选择器**禁掉**。

**结论：过滤/重查是父组件的活。** 要让选择器生效，父组件必须：① 去掉 `disabled-range`、把 `:range="null"` 改成 `:range="某 ref"`、加 `@update:range`；② 在 handler 里据新区间**重新取/裁数据**喂回 `:data`。

有**两种**接法，按"该调用方手里是否握有全量历史数据"决定：

| 接法 | 适用 | 参照实现 |
|---|---|---|
| **A. 客户端裁切** | 父组件已持全量历史（内存里有全部 bar） | `UsIndexPanel.vue`（已上线）：`allBars` 全量 + `displayBars` computed 按本地日历日 `YYYY-MM-DD` 字符串闭区间 filter，`msToDateStr` 用本地 getter |
| **B. 服务端重查** | 父组件只拉了"最近 N 根"有界窗口，不握全量 | `FlowTrendModal.vue`（已实现）：`klineRange` ref + `@update:range="onKlineRangeChange"` + `tsToYYYYMMDD`（本地日历日）+ 用新 start/end 重新请求后端 |

> 绝大多数调用方是 B（按计数拉有界窗口）。**不要**对 B 类硬套客户端裁切——它手里只有那 N 根，用户选更早的日期会静默截断、误导成"无数据"。

## 现状地图（实测，按处理方式分层）

> ⚠️ 教训（已发生）：摸底子代理只读 `.vue` 就断言"A股/美股 klines 必须改后端"——**错的**。去 API + controller 源头一查，date-range 早已端到端支持。**进任何"要不要改后端"的结论前，自己 grep API 模块签名 + 后端 controller 一眼。**

### Tier 0 — 已完成 / 参照实现（不动）
| 文件 | 接法 | 说明 |
|---|---|---|
| `symbols/us-index/UsIndexPanel.vue` | A 客户端 | 已上线（本系列起点）。含额外的"默认近 200 根"，本交接其它处**不复制**该默认 |
| `money-flow/FlowTrendModal.vue` | B 服务端 | 已正确接线（`:range="klineRange"` + `@update:range` + 重查 + `initKlineRangeDefault` 默认近 120 天）。**抽 composable 时以它为范本，并把它重构成消费新 composable** |

### Tier 1 — 纯前端即可（API + 后端已支持 start/end，高价值低风险，**本交接主体**）
| 文件 | 当前模板 | 数据来源 | range 支持（已验证） |
|---|---|---|---|
| `symbols/a-shares/AShareDetailDrawer.vue` | :29-39 `:range="null"` `disabled-range` `granularity="date"` `prefs="a-share"` `:data="klineRows"` | `aSharesApi.getKlines(symbol, 360, 'qfq')`（有界 360） | ✅ `aShares.ts:155-165` 带 `range:{startDate,endDate}` → `a-shares.controller.ts:56-69` 透传 service |
| `symbols/us-stocks/UsStockDetailDrawer.vue` | :28（35-36）`:range="null"` `disabled-range` `prefs="us-stock"` | `fetchUsStockKline(ticker,360,priceMode)` → `usStocksApi.getKlines` | ✅ `usStocks.ts:96-106` 带 `range` → `us-stocks.controller.ts:42-56` 透传 |
| `watchlist/WatchlistTable.vue`（**仅 A 股路径**） | :76（84）`:range="null"` `disabled-range`，granularity=`watchlistGranularity`（A股→date，crypto日线→date，否则hour，L133-137） | `openChart()` L261-275：A股 `aSharesApi.getKlines(symbol,360,'qfq')` | ✅ 同 a-shares |

`aSharesApi.getKlines` 的 range 路径有"活证"：`SignalTradeKlineModal.vue` 本就在用 startDate/endDate 调它且能跑。

### Tier 2 — 需后端先加 start/end（建议拆成后续独立任务，**先和用户确认是否纳入本批**）
| 文件 | 缺口 |
|---|---|
| `symbols/CryptoSymbolsPanel.vue`（:92-103，`klinesApi.getKlines(symbol, interval)`） | `symbols.ts:144-145` 无 range 参数；后端 `/klines/:symbol/:interval` 需加 start/end。另：crypto 有 `hour` 粒度→选择器是 datetimerange，转换不能只到日（YYYYMMDD 会丢时分） |
| `watchlist/WatchlistTable.vue`（**crypto 路径**） | 同上（A股路径属 Tier 1，crypto 路径卡在 crypto 接口） |
| `symbols/ActiveMarketValuePanel.vue`（:88，`oamvApi.getData(250)`，`oamv.ts:52-54` 仅 `days`） | `/oamv/data` 只按计数取，需加 start/end（注意 0AMV 是派生指标、面板定位"看近期象限"，是否真需要自由选区间也值得先问用户） |

### Tier 3 — 固定上下文，保持禁用（**不接，按证据判定**，用户已认可此策略）
| 文件 | 为什么不接 |
|---|---|
| `backtest/KlineChartModal.vue`（:33，`backtestApi.getKlineChart(runId,{symbol,ts,before:100,after:30})`） | 以回测某根 K 线为锚点取前 100/后 30 根，配 `:current-ts` 高亮；窗口本就 ~130 根且语义是"看信号 K 线上下文"，再按日期裁会把锚点/信号裁掉 |
| `strategy/SignalTradeKlineModal.vue`（:11，`aSharesApi.getKlines` 取 signalDate-30~exitDate+20 + 注入买卖点标记） | 单笔交易固定上下文 + 买卖点标注，日期过滤会破坏标注语义 |

> 注：`backtest/CandleRunSymbolMetrics.vue` 不是调用方——它渲染的是 `<KlineChartModal>`（:41），无需改。

## 已定方向（用户已拍板）

1. **范围**：只接日期过滤；**不**把"默认近 200 根"铺到各处（各 B 类调用方默认窗口维持现状，清空区间即回默认窗口）。
2. **复用**：**抽共享 composable**，不要每处复制一遍 `range`/转换/重查逻辑。
3. **特例**：按扫描证据判定——Tier 3 保持 `disabled-range`，并在各处留一行注释说明豁免理由。

## 待敲定的开放问题（动手前先问用户/brainstorm）

- **Tier 2 是否纳入本批**？crypto + AMV 需要后端先加 start/end（crypto 还要处理 hour 粒度的 datetimerange）。建议：本批先交付 Tier 1 + composable + 重构 FlowTrendModal，Tier 2 拆后续。
- **composable 的边界**：B 类（服务端重查）和 A 类（客户端裁切）共享的其实是 ①`range` ref + `onRangeUpdate` ②**picker 本地午夜 ms → 日期串的转换**（这是当前全项目重复且最易错 TZ 的点：us-index 有 `msToDateStr`、FlowTrendModal 有 `tsToYYYYMMDD`、`aSharesFormatters` 有 `formatTushareDate`/`formatDisplayDate`）。建议 composable 至少统一 ①②；A 类的 filter 与 B 类的 refetch 各自注入。是否把 us-index 也迁来用统一 util（一致性收益，可选）由实现者定。

### composable 建议形态（草案，实现者可调整）
```ts
// apps/web/src/composables/kline/useKlineRangePicker.ts
// B 类服务端重查用：选了区间 → 回调 YYYYMMDD 让调用方重查；清空 → 回调 null（调用方重取默认窗口）
export function useKlineRangePicker(onApply: (r: { startDate: string; endDate: string } | null) => void) {
  const range = ref<[number, number] | null>(null)
  function onRangeUpdate(v: [number, number] | null) {
    range.value = v
    onApply(v ? { startDate: msToYyyymmdd(v[0]), endDate: msToYyyymmdd(v[1]) } : null)
  }
  function reset() { range.value = null }
  return { range, onRangeUpdate, reset }
}
// 共享 util（apps/web/src/composables/kline/klineDateRange.ts）：
//   msToYyyymmdd(ms) → 'YYYYMMDD'，msToYyyyMmDd(ms) → 'YYYY-MM-DD'
//   一律本地 getter（getFullYear/getMonth/getDate），见硬约束
```

## 硬约束 / 项目规范

- **日期 TZ（必读 `.claude/rules/datetime.md`「日期选择器是本地 TZ 例外」）**：`n-date-picker` 的 `[number,number]` 是**本地午夜 ms**。提取年月日**只能**用 `getFullYear/getMonth/getDate`，**禁** `getUTC*`，否则 CST 用户选区整体漂前 1 天。后端入参格式：A股/美股 klines 用 `YYYYMMDD`（见各 API 签名注释）。
- **range + limit 的坑（务必处理）**：B 类调用方现在带 `limit=360`。选了一个跨度 > 360 根的区间时，若仍传 `limit=360` 会被后端截断、区间名不副实。重查时要么传足够大的 limit、要么确认后端"有 range 时忽略 limit"。先去 service 看 range 与 limit 的优先级（落源头，别猜）。
- **别采信二手转述**（`.claude/rules/data-integrity.md`）：本交接的分层已验证，但你接手后凡要写进"必须改后端/不用改"的结论，**自己再 grep API 签名 + controller/service 一眼**。
- **单文件 ≤ 500 行**（`.claude/rules/code-organization.md`）。
- **前端合并前必跑 `pnpm --filter @cryptotrading/web build`（vite）**，不能只 `type-check`——`vue-tsc` 查不出 SFC 模板/宏编译错（`.claude/rules/vue3-frontend.md`）。
- **改 import 块后立即回读文件头部**验证顺序。
- **n-select 自定义 options 接口须 `extends SelectOption`**（本任务大概率用不到，列此备查）。

## 验证标准

每个改动的调用方：
1. `pnpm --filter @cryptotrading/web type-check` + **`build`** 绿。
2. 单测：为每个新接线的调用方补/改 spec（参照 `us-index/__tests__/UsIndexPanel.spec.ts` 的 stub 思路——stub KlineChart 记录收到的 `:data` 形态，用 `vm.$emit('update:range', …)` 驱动父 handler，断言重查被调用/数据变化）。B 类断言"选区间→以对应 start/end 重新请求 API"、"清空→回默认窗口请求"。
3. **真机 e2e**：本系列的 K 线面板 headless 截图历史上 flaky（naive-ui tab + 大量重渲染），优先验数据层（API 请求参数、返回行数、`:data` 长度），canvas 目视交给人工。改动会动到用户列偏好/抽屉状态的，验完恢复默认。
4. 重构 FlowTrendModal 复用 composable 后，确认其行为零回归（默认 120 天窗口、选区重查、清空）。

## 前序进度 / 背景

- us-index 的接线（客户端裁切 + 默认近 200 根）已于 2026-06-17 上线（单文件 `UsIndexPanel.vue` + 3 个回归测试，全门禁绿），是本系列起点与 A 类参照。详见记忆 `project_us_index_subtab.md`。
- 本交接是其延伸："让**所有**调用方都响应 update:range"。

## 建议执行顺序

1. 抽 `klineDateRange.ts`（ms→日期串 util）+ `useKlineRangePicker.ts`（B 类）。
2. 用新 composable **重构 `FlowTrendModal.vue`**（已工作的范本，验证 composable 设计）。
3. 接 Tier 1 三处（AShareDetailDrawer / UsStockDetailDrawer / WatchlistTable 的 A 股路径）。
4. Tier 3 两处加豁免注释（保持禁用）。
5. 与用户确认 Tier 2（crypto/AMV）是否本批做；做则先补后端 start/end。
6. 各步 type-check + build + 单测，最后真机数据层抽验。
