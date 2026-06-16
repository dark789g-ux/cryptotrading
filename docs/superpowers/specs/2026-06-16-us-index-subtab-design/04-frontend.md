# 04 · 前端（二级 Tab + 指数面板 + K 线）

← 返回 [index.md](./index.md) | 依赖 [02 接口](./02-backend-nestjs.md)

单文件 **≤500 行**；合并前必跑 `pnpm --filter @cryptotrading/web build`（vite，type-check 查不出 SFC 编译错，`.claude/rules/vue3-frontend.md`）。注释里勿写含 `*/` 的 token。

## 改动清单

```text
新 components/symbols/UsStocksTabsContainer.vue   二级 n-tabs 包装 + resize 编排
新 components/symbols/us-index/UsIndexPanel.vue    指数选择 + 同步 + KlineChart
新 api/modules/market/usIndexDaily.ts              query / getDateRange / triggerSync
改 views/market/SymbolsView.vue                    L56 <us-stocks-panel/> → <us-stocks-tabs-container/> + 注册
```

## 1. UsStocksTabsContainer.vue（新）

```text
┌─ UsStocksTabsContainer ────────────────────────────────┐
│ <n-tabs type="line" animated display-directive="show:lazy" │
│         v-model:value="subTab">                          │
│   ┌─ n-tab-pane name="stocks" tab="美股" ──────────────┐ │
│   │   <UsStocksPanel/>            (原样, 零改, 无 props) │ │
│   └──────────────────────────────────────────────────┘ │
│   ┌─ n-tab-pane name="index" tab="美股指数" ───────────┐ │
│   │   <UsIndexPanel ref="indexPanelRef"/>               │ │
│   └──────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────┘
```

- `display-directive="show:lazy"`：首次激活后保持渲染（echarts 这类有副作用组件适用；参照 [SignalTestConfigPanel.vue:8](../../../../apps/web/src/components/strategy/SignalTestConfigPanel.vue)）。
- **resize 编排**（keep-alive + echarts 不自动 resize）：
  - `watch(subTab)`：切到 `'index'` → `nextTick(() => indexPanelRef.value?.resize())`。
  - `onActivated()`（本容器在 SymbolsView 顶层 `<keep-alive>` 内）：若当前 `subTab==='index'` → `nextTick` 调 `indexPanelRef.value?.resize()`（从别的顶层 Tab 切回时 echarts 容器尺寸可能已变）。
  - `UsIndexPanel` 经 `defineExpose({ resize })` 把调用转发给内部 `KlineChart` ref 的 `resize()`（KlineChart 实际 `defineExpose({ resize: handleResize, renderChart })`，[KlineChart.vue:222](../../../../apps/web/src/components/kline/KlineChart.vue)——只需调 `resize`，另有 `renderChart` 不用）。

## 2. UsIndexPanel.vue（新）

```text
┌─ UsIndexPanel ─────────────────────────────────────────┐
│ 指数: [纳斯达克100 ▾]   [同步指数数据]   (右上)         │
├────────────────────────────────────────────────────────┤
│  <KlineChart :data=bars :availableSubplots=['VOL','KDJ', │
│      'MACD'] prefsKey="us-index" :height="'640px'"       │
│      showToolbar ref="klineRef"/>                        │
└────────────────────────────────────────────────────────┘
   + 同步进度组件(复用 us-stocks): 监听 jobId, success 后 reload
```

- **指数选择**：`n-select`，v1 选项硬编码单项 `[{ label: '纳斯达克100', value: '.NDX' }]`，`selectedIndex = ref('.NDX')`。P2 扩 `.IXIC/.DJI/.INX` 只加选项。`<n-select>` 自定义选项须 `extends SelectOption`（`.claude/rules/vue3-frontend.md`）。
- **数据加载**：
  1. `getDateRange('.NDX')` → `{ start, end }`；空则提示「未灌数据，请先同步」。
  2. `query({ index_code, start_date: start, end_date: end })` → `KlineChartBar[]` 直接喂 `:data`。
  3. `open_time` 后端已 `YYYY-MM-DD`，与副图同数组对齐（无跨源 FLOW，字面相等不成问题）。
  - keep-alive 注意：数据加载放 **`onActivated` 优先**（容器懒渲染 + 顶层 keep-alive，`onMounted` 切回不重跑；`.claude/rules/vue3-frontend.md`）；首次进入 + selectedIndex 变化均触发 reload。
- **同步**：`[同步指数数据]` → `usIndexApi.triggerSync()`（**无 body**）→ `{ jobId }` → 打开 **`UsSyncProgressModal`**（**复用 us-stocks 同款**，UsStocksPanel 从 `./us-stocks/UsSyncProgressModal.vue` import；用法 `v-model:show="showSyncProgress"` + `:job-id="syncJobId"` + `@done="handleSyncDone"`，参照 [UsStocksPanel.vue:75-79](../../../../apps/web/src/components/symbols/UsStocksPanel.vue)，`@done` 收到 `'success'` 后 `reload()`）。无 body 同步 → 后端 params 无 date_range/symbols → **worker 兜底默认全量 + `('.NDX',)`**（见 [03 §4](./03-python-pipeline.md)），故无参按钮真能跑通（不重蹈 us-stocks latent bug）。
- **resize**：`defineExpose({ resize: () => klineRef.value?.resize() })`。

## 3. api/modules/market/usIndexDaily.ts（新）

结构参照 [thsIndexDaily.ts](../../../../apps/web/src/api/modules/market/thsIndexDaily.ts)（`query` 同形），但 **`getDateRange` 不照搬**——ths 版**无参**且返回 `{min,max}`；本模块要按 `index_code` 取范围、返回 `{start,end}`（与 [02 端点契约](./02-backend-nestjs.md#端点契约) 一致）：

```text
interface UsIndexQuery { index_code: string; start_date: string; end_date: string }
usIndexApi.query(params: UsIndexQuery): Promise<KlineChartBar[]>   GET  /api/us-index-daily
usIndexApi.getDateRange(index_code: string): Promise<{start:string|null,end:string|null}>  GET /api/us-index-daily/date-range?index_code=
usIndexApi.triggerSync(body?: {dateRange?:[string,string]; symbols?:string[]}): Promise<{ jobId: string }>   POST /api/us-index-daily/sync
```

`KlineChartBar` 复用 `@/api/modules/market/symbols` 的类型，**不新声明**。`getDateRange` 返回键 `{start,end}` 与后端 02 对齐；§2 解构 `const { start, end } = await usIndexApi.getDateRange('.NDX')`。

## 4. SymbolsView.vue（改）

- L56 `<us-stocks-panel v-else />` → `<us-stocks-tabs-container v-else />`；import + 注册 `UsStocksTabsContainer`。
- 顶层 `activeTab` 联合类型、4 个手写 button **不动**（[SymbolsView.vue:42,70](../../../../apps/web/src/views/market/SymbolsView.vue)）。`<keep-alive>` 结构不动。

## vitest

- `usIndexDaily.ts`：mock http → `query`/`getDateRange`/`triggerSync` URL + 参数正确，返回透传。
- `UsIndexPanel`：mock api，断言挂载触发 `getDateRange`→`query`；同步按钮触发 `triggerSync` 并开进度组件；`resize` expose 转发到 KlineChart ref（可 mock）。
- `UsStocksTabsContainer`：切到 `index` tab 调 `indexPanelRef.resize`（mock）。

## 验证

`pnpm --filter @cryptotrading/web type-check` + **`build`（vite）** 双绿 + vitest 全过；真机见 [05](./05-testing-rollout.md)。
