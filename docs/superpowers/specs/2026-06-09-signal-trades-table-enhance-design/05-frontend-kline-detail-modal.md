# 05 · 前端 F1：详情 K 线 Modal

← [04](./04-frontend-trades-panel.md) ｜ [index](./index.md) ｜ 下一篇 [06](./06-implementation-sequence.md)

## 目标

点击操作列「详情」弹 Modal，展示该笔交易标的在交易窗口内的 K 线，并标注买入/出场点。依赖 [01 后端日期窗口](./01-backend-a-shares-kline-window.md) 与 [03 契约](./03-frontend-api-store-contracts.md)。

## 参照现成（file:line）

- `components/money-flow/FlowTrendModal.vue`：`AppModal` + `#default="{ maximized }"` 切图高、内嵌 `KlineChart` 的标准范本。
- `components/backtest/KlineChartModal.vue`：watch `show` 触发加载、关闭清空 `data=[]` 的范本。
- K 线标记机制：`klineChartTooltip.ts:78` `buildMarkPoints` 读 `bar.trades`，`type==='entry'`→`B`、`'exit'`→`S`；`bar.open_time === currentTs` 的那根高亮放大。
- `TradeOnBar`（`symbols.ts:3`）：`{ type:'entry'|'exit'; symbol:string; price:number; shares:number; reason:string; pnl?:number }`。

## 布局（ASCII）

```text
┌─ 000001.SZ 平安银行 · 买 2026-03-12 / 卖 2026-03-19 · +3.2% ──────[⛶][✕]┐
│ ┌──────────────────────────────────────────────────────────────────────┐ │
│ │   K线主图        B↑(买入,高亮)            S↓(出场)                     │ │
│ │   ── MA/BBI ──                                                        │ │
│ │   VOL / KDJ / MACD 副图                                               │ │
│ └──────────────────────────────────────────────────────────────────────┘ │
└────────────────────────────────────────────────────────────────────────────┘
```

## 组件 `SignalTradeKlineModal.vue`

### Props / 模型

```ts
const props = defineProps<{ show: boolean; trade: SignalTestTrade | null }>()
const emit = defineEmits<{ (e:'update:show', v:boolean): void }>()
```

### 模板骨架

```vue
<AppModal
  :show="show" :title="headerTitle" width="min(1100px, 96vw)" maximizable
  @update:show="emit('update:show', $event)"
>
  <template #default="{ maximized }">
    <n-spin :show="loading">
      <KlineChart
        v-if="bars.length"
        :data="bars"
        :current-ts="entryTs"
        :height="maximized ? 'calc(92vh - 160px)' : '560px'"
        show-toolbar disabled-range granularity="date"
        prefs-key="signal-kline"
        :available-subplots="['VOL','KDJ','MACD']"
      />
      <n-empty v-else-if="!loading" description="无 K 线数据" />
    </n-spin>
  </template>
</AppModal>
```

- `availableSubplots` 排除 `FLOW/0AMV/0AMV_MACD`（不 merge 资金流/AMV）。
- `prefs-key='signal-kline'` 独立副图偏好，不与 backtest/a-share 混。
- 无 `#actions`（纯查看，AppModal 不渲染 footer）。

### 标题

```ts
const headerTitle = computed(() => {
  const t = props.trade; if (!t) return 'K 线详情'
  return `${t.tsCode} ${t.name ?? ''} · 买 ${fmt(t.buyDate)} / 卖 ${fmt(t.exitDate)} · ${pct(t.ret)}`
})
```

### 取数 + 注入标记

```ts
const bars = ref<KlineChartBar[]>([]); const loading = ref(false)
const entryTs = ref('')      // = fmtTradeDate(buyDate)，用于高亮

let reqSeq = 0
async function load() {
  const t = props.trade; if (!t) return
  const my = ++reqSeq; loading.value = true
  try {
    const range = {
      startDate: shiftYmd(t.signalDate, -30),   // 默认①
      endDate:   shiftYmd(t.exitDate,   +20),
    }
    const raw = await aSharesApi.getKlines(t.tsCode, 500, 'qfq', range)   // 默认⑥ qfq
    if (my !== reqSeq) return
    bars.value = injectMarkers(raw, t)
    entryTs.value = fmtTradeDate(t.buyDate)
  } finally { if (my === reqSeq) loading.value = false }
}

watch(() => props.show, (s) => {
  if (s) load()
  else { bars.value = []; entryTs.value = '' }   // 关闭清空，KlineChart data 空会 dispose（标准）
})
```

### 关键工具

```ts
// YYYYMMDD ± days → YYYYMMDD（datetime 规范：转 Date 必插分隔符 + Z）
function shiftYmd(ymd: string, days: number): string {
  const d = new Date(`${ymd.slice(0,4)}-${ymd.slice(4,6)}-${ymd.slice(6,8)}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth()+1).padStart(2,'0')}${String(d.getUTCDate()).padStart(2,'0')}`
}

// 在买/卖那根 bar 注入 trades 标记。
// ⚠️ 对齐 key 字面相等：bar.open_time 是 'YYYY-MM-DD'，buyDate/exitDate 是 'YYYYMMDD'，
//    必须用 fmtTradeDate 转换后比对（datetime 规范：副图对齐 key 不得假设同源格式）。
function injectMarkers(raw: KlineChartBar[], t: SignalTestTrade): KlineChartBar[] {
  const buyKey = fmtTradeDate(t.buyDate)     // 'YYYY-MM-DD'
  const exitKey = fmtTradeDate(t.exitDate)
  return raw.map((bar) => {
    const trades: TradeOnBar[] = []
    if (bar.open_time === buyKey)
      trades.push({ type:'entry', symbol:t.tsCode, price:+t.buyPrice, shares:0, reason:'买入' })
    if (bar.open_time === exitKey)
      trades.push({ type:'exit', symbol:t.tsCode, price:+t.exitPrice, shares:0, reason: exitReasonLabel(t.exitReason) })
    return trades.length ? { ...bar, trades } : bar
  })
}
```

- `fmtTradeDate` / `exitReasonLabel` 从 [04 共享 util](./04-frontend-trades-panel.md#组件拆分) `components/strategy/signalStatsFormatters.ts` import（勿在本组件内联，保口径一致）。
- `shares:0`（信号统计不跟踪股数，标记不依赖它）；`reason` 中文取自 `exitReasonLabel`。
- 若买/卖日恰逢停牌（窗口内无对应 bar），该标记自然不显示——可接受（窗口仍展示前后行情）。

## 嵌套 Modal 说明（默认③）

`SignalStatsResult` 已在 `SignalStatsView.vue:23` 的 `AppModal` 内，本 Modal 为其上层叠加。Naive UI 支持 Modal 堆叠；统一用 `AppModal`（vue3-frontend 规范，禁裸 `n-modal`）。

## 验证

1. `pnpm --filter @cryptotrading/web type-check` 且 `vite build`。
2. 真机：
   - 选一笔**历史**交易（信号日较早）点详情 → K 线确实落在交易窗口（验证日期窗口生效，非「最近 N 根」）。
   - 图上 `B`（买入日高亮）/`S`（出场日）位置与表格 buyDate/exitDate 对齐；价位与 buyPrice/exitPrice 吻合（qfq）。
   - 切换最大化高度自适应（ECharts ResizeObserver 自动 resize）。
   - 关闭再开另一笔，数据刷新无残留（reqSeq + 关闭清空）。
   - **首开 canvas 渲染正常**（KlineChart 内部 `nextTick + rAF` 已处理 Modal 可见后才 init）。

## 文件清单

- `apps/web/src/components/strategy/SignalTradeKlineModal.vue`（新）
- 依赖类型/函数：`TradeOnBar`、`KlineChartBar`（`api/modules/market/symbols.ts`）、`aSharesApi.getKlines`（[03](./03-frontend-api-store-contracts.md)）。
