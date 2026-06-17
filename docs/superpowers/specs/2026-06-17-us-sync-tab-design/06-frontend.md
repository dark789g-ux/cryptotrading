# 06 前端

[← index](./index.md)

核心思路：**复用 `OneClickSyncPanel.vue` 展示组件**（轻度参数化），A 股 / 美股各喂一个实现**同一接口**的 controller。

## SyncView.vue 改 Tab

现有（SyncView.vue ✅已核）只渲染一张 A 股卡。改为外层 `n-tabs`：

```text
<n-tabs type="line" v-model:value="activeTab">
  <n-tab-pane name="ashare" tab="A股">
    <OneClickSyncPanel :controller="aCtrl"
        title="一键同步 A 股核心数据"
        subtitle="基础数据 → A股数据 → 资金流向 → 指数日线 → AMV → 0AMV" />
  </n-tab-pane>
  <n-tab-pane name="us" tab="美股">
    <OneClickSyncPanel :controller="usCtrl"
        title="一键同步美股数据"
        subtitle="美股个股 → 美股指数日线 → 美股指数 AMV" />
  </n-tab-pane>
</n-tabs>
```

- `aCtrl = useOneClickSync(message)`（现有），`usCtrl = useUsOneClickSync(message)`（新）。
- onMounted 各自 `fetchActive + resume`；onUnmounted 各自 `stopPolling`（两 store 独立）。状态全在各自 Pinia store，无需 keep-alive（与现有 SyncView 注释一致 ✅已核）。
- **懒加载注意**：若用 `n-tabs` 默认（非 lazy），两 Tab 组件同时挂载、两 store 同时轮询——可接受（轮询仅在各自 running 时启动）。若用 `display-directive="show:lazy"`，注意 [懒 tab-pane onActivated 不触发] 坑，首屏加载逻辑用 `onMounted`。推荐**非 lazy**（两面板都轻）。

## OneClickSyncPanel 参数化

现有 `OneClickSyncPanel.vue`（✅已核）硬编码标题/副标题（模板 L8-12）、`controller?: ReturnType<typeof useOneClickSync>`（L164-166）。改动：

1. `defineProps` 加 `title?: string`、`subtitle?: string`（默认值给 A 股原文，保证 A 股零行为变化；默认值用**内联字面量**，遵守 [withDefaults 默认值禁引用局部变量] 规则）。
2. 模板 L8-12 改用 `{{ title }}` / `{{ subtitle }}`。
3. `controller` prop 类型从 `ReturnType<typeof useOneClickSync>` 改为接口 `OneClickPanelController`（见下），解耦面板与具体 controller。

> 纯展示改动，零逻辑变化；A 股路径行为不变（仅多两个有默认值的 props）。

## 面板 controller 接口

在 `components/sync/oneClickSync.types.ts`（✅已核含 `OneClickStepState/Summary/LogEntry/STEP_LABELS/toYYYYMMDD`）抽出接口，A 股 / 美股 controller 共同实现：

```typescript
export interface OneClickPanelController {
  dateRange: Ref<[number, number] | null>
  running: ComputedRef<boolean>
  steps: ComputedRef<OneClickStepState[]>      // 已带 label
  totalPercent: ComputedRef<number>
  logEntries: ComputedRef<LogEntry[]>
  currentStepIndex: ComputedRef<number>
  elapsedMs: ComputedRef<number>
  summary: ComputedRef<OneClickSummary | null>
  canStart: ComputedRef<boolean>
  start: () => Promise<void>
  cancel: () => Promise<void>
}
```

现有 `useOneClickSync` 的返回（useOneClickSync.ts ✅已核）已是此形状——加一行 `: OneClickPanelController` 标注即可。

### 美股 step key / label

美股步骤 key 不在 A 股 `OneClickStepKey` 联合内。`step: OneClickStepKey` 在 `oneClickSync.types.ts` **三处**出现：`OneClickErrorItem.step`（L15 ✅已核）、`OneClickStepState.step`（L22 ✅已核）、`LogEntry.step`（L36 ✅已核，已含 `'system'`）。美股 adapter 会产出 `steps[].step`/`errors[].step`/`logs[].step = 'us-stocks'` 等，**三处必须统一放宽**，否则 type-check 报错（仅放宽 `OneClickStepState.step` 会漏 `OneClickErrorItem.step` / `LogEntry.step`）。

**方案**：三处 `step` 字段统一放宽为 `string`（最简），或都改成 `OneClickStepKey | UsOneClickStepKey` 联合；新增 `US_STEP_LABELS`：

```typescript
export const US_STEP_LABELS: Record<string, string> = {
  'us-stocks': '美股个股',
  'us-index-daily': '美股指数日线',
  'us-index-amv': '美股指数 AMV',
}
```

> 放宽 `step: string`（三处）最简，面板按 key 取 label、渲染均 key-agnostic（OneClickSyncPanel 用 `step.step` 作 :key、`step.status` 作 class ✅已核），不影响 A 股（A 股仍传它那套 key）。

## usOneClickSync store（新）

镜像 `oneClickSync` store（✅已核：`currentRun` + 2s 轮询 + `fetchActive` + `resumeAllPolling` + `stopPolling` + `startRun` + `cancelRun`），但数据源是 **ml.jobs 行的 result_payload**：

```text
state: currentJob: JobRow | null, pollTimer
getters（从 currentJob.resultPayload 派生，对齐 A 股 store getter 形状）:
  running        = currentJob?.status === 'running'
  steps          = resultPayload.steps.map(withUsLabel)   // 补 label
  totalPercent   = currentJob?.progress ?? 0
  logs           = resultPayload.logs ?? []
  currentStepIndex = steps.findIndex(running) 兜底
  elapsedMs      = (finishedAt ?? now) - startedAt
  currentRun(summary 源) = 终态时由 resultPayload 派生 OneClickSummary
actions:
  startRun({startDate,endDate}) → POST /api/us-stocks/one-click-sync → 存 jobId → 启动轮询
  fetchActive() → GET /api/quant/jobs?run_type=us_one_click_sync&page_size=1 → items[0]
  resumePolling() → currentJob.status==='running' 则启 2s 轮询 GET /api/quant/jobs/:id
  cancelRun() → POST /api/quant/jobs/:id/cancel
  stopPolling()
  轮询每 tick：GET /api/quant/jobs/:id 刷 currentJob；终态停轮询
```

> result_payload 可能为 `{}`（job 刚建、worker 未写）→ steps 兜底为「3 步 pending」初始态，避免空数组渲染空白。

## useUsOneClickSync controller（新）

瘦适配层（仿 useOneClickSync.ts ✅已核结构）：本地 `dateRange` ref（n-date-picker 本地午夜 ms，无默认 = null）；`canStart = !running && dateRange 两端齐全`；`start()` 用 `toYYYYMMDD`（✅已核，本地 TZ 提取，遵守 [日期选择器是本地 TZ 例外] 规则）转 YYYYMMDD 调 `store.startRun`；其余 getter 透传 store。返回类型标 `OneClickPanelController`。

## API client + 类型

`api/modules/market/usStocks.ts`（✅已核）加：

```typescript
export interface UsOneClickSyncBody { dateRange: [string, string] }
export async function startUsOneClickSync(body: UsOneClickSyncBody): Promise<{ jobId: string }>
  // POST /api/us-stocks/one-click-sync
```

`api/modules/quant.ts`：

- `JobRow`（L179-206 ✅已核）加 `resultPayload?: Record<string, unknown>`。
- `JobRunType`（L135-148 ✅已核）加 `'us_one_click_sync'`（既有 drift 仅补此项，见 [02](./02-run-type-and-migrations.md#-前端-jobruntypequantts)）。
- 复用现有 `getJob(id)` / 列表查询 / `cancelJob(id)`（若已封装；store 直接复用，避免重复封装）。

## 验证

- `pnpm --filter @cryptotrading/web type-check` + **`pnpm --filter @cryptotrading/web build`（vite SFC 编译，必跑）**（遵守 [前端改动合并前必跑 vite build] 规则）。
- `pnpm --filter @cryptotrading/web lint:quant-lines` 不涉及（sync 目录不在 quant 强制范围，但单文件仍守 ≤500 行）。
- controller/store 适配单测：result_payload → steps/logs/summary 映射正确；空 payload 兜底 3 步 pending。
