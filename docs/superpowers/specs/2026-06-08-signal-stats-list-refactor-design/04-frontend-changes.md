# 04 · 前端改动

[← 返回 index](./index.md) · [← 03 后端改动](./03-backend-changes.md)

## 1. 文件拆分（守 ≤500 行 / 边界清晰）

| 文件 | 角色 | 约 |
|---|---|---|
| `views/strategy/SignalStatsView.vue` | 容器：全宽表格 + 详情/编辑两个 AppModal 编排 | 改写 |
| `views/strategy/SignalStatsTable.vue` | 表格：10 列 render 定义 + 操作按钮（render 多，单拆） | 新建 |
| `views/strategy/SignalStatsResult.vue` | 详情弹窗主体：配置摘要 + 10 统计卡 + n-tabs | 改造 |
| `components/strategy/RetHistogram.vue` | ECharts 收益率直方图 | 新建 |

**边界**：

- `SignalStatsView` 只管「列表数据 + 选中态 + 两个 modal 开关 + CRUD/run 调度」，不含列渲染细节。
- `SignalStatsTable` 通过 props 收 `tests/loading/runningId`，通过 emit 发
  `run/detail/edit/delete` 事件；不直接调 store（保持纯展示，可测）。
- `SignalStatsResult` 收 `:test`（含 latestRun），内部按 status 分支渲染；直方图/明细懒加载。
- `RetHistogram` 收 `:run-id`，自取数据、自渲染、自销毁，外部无需关心 ECharts 实例。

> `SignalStatsTable.vue` 放 `views/strategy/`（页面专用）；`RetHistogram.vue` 放
> `components/strategy/`（可复用图表组件，与 `components/quant/ShapBarChart.vue` 同层级语义）。

### 1.1 `SignalStatsResult` 的破坏性契约变更（必须显式改）

现状（已核对）：prop 是 `testId: string | null`（`SignalStatsResult.vue:158,161`），内部**自取**最新
完成 run —— `historyCompleted = store.runsMap.get(testId)?.find(r => r.status==='completed')`
（`:174`），并读 `store.runProgress.get(testId)`（`:171`）。即数据获取在组件内部、依赖 `runsMap`。

改造后：

| | before | after |
|---|---|---|
| prop | `:test-id="selectedTestId"` | `:test="selectedTest"`（`SignalTestWithLatestRun`，含 `latestRun`） |
| run 数据源 | 内部 `runsMap.get(testId).find(...)` | 直接 `props.test.latestRun`（list 接口已带回，**不再** `fetchRuns`） |
| 统计卡 | 读自取 run | 读 `props.test.latestRun` 各字段（+ 新增 `bestTradeRet`） |
| 历史运行表 | 渲染（`SignalStatsResult.vue:112-120` + `runColumns`） | **删除**（test 一次性，见 index 决策 5） |
| 直方图/明细 | 无直方图；明细自取 | n-tabs 包裹；runId 取 `props.test.latestRun.id` |

实现要点：删 `runsMap`/`runProgress` 相关引用与 `runColumns`（`:285-360`）、历史表区块
（`:112-120`）；`SignalStatsView.vue:61` 的 `<SignalStatsResult :test-id=...>` 同步改为
`:test`。改前**全仓 grep `SignalStatsResult`** 确认仅 `SignalStatsView` 引用（见
[05 §5 风险表](./05-testing-and-verification.md)）。

## 2. API 模块 `api/modules/strategy/signalStats.ts`

### 2.1 类型

- `SignalTestRun` 接口加 `bestTradeRet: string | null`（紧随 `worstTradeRet`）。
- 新增 `SignalTestWithLatestRun = SignalTest & { latestRun: SignalTestRun | null }`。
- `signalStatsApi.findAll()`（**现有方法名是 `findAll`，非 `listTests`**；`signalStats.ts:101`）
  返回类型由 `SignalTest[]` 改为 `SignalTestWithLatestRun[]`。
- 新增直方图类型：

```ts
export interface RetHistogramBin {
  lo: number
  hi: number
  count: number
  sign: 'win' | 'loss'
}
export interface RetHistogramResult {
  runId: string
  sampleCount: number
  binWidth: number | null
  bins: RetHistogramBin[]
}
```

### 2.2 方法

```ts
getRetHistogram(runId: string, bins = 25): Promise<RetHistogramResult>
  // GET /signal-tests/runs/:runId/ret-histogram?bins=
```

## 3. store `stores/signalStats.ts`

- `tests` 的类型改为 `SignalTestWithLatestRun[]`。
- 新增 `histogramMap: Record<string, RetHistogramResult>`（按 runId 缓存）+ action
  `fetchRetHistogram(runId)`（已缓存则直接返回，避免重复请求）。
- **run 完成后刷新表格行（含 runId 来源约束）**：现 `startRun` 轮询走 `getRunProgress(id)`，
  返回的 `SignalTestRunProgress`（`signalStats.ts:59-75`）**不含 `id`、不含 `createdAt`** ——
  所以**直方图/明细的 runId 一律取自 `test.latestRun.id`（来自 `fetchTests`），绝不取自轮询
  progress**。据此，`startRun` 轮询到 `completed` 后**必须 `await this.fetchTests()`**，让表格行
  的 `latestRun`（状态/指标列 + `latestRun.id`）刷新到最新，详情弹窗才拿得到可用的 runId。
  （MVP 先整表 fetchTests；后续可优化为只 patch 对应 test 的 latestRun，避免整表重拉。）
- **强依赖顺序**：表格指标列、状态列、详情 runId 全部依赖「改动 B：findAll 返回 latestRun」。
  后端 B 未上线前前端这些字段为 `undefined`/`null`，须容错显 `—`，不可崩。
- `fetchTrades` / `tradesMap` 保留不变（详情明细 tab 复用）。
- 可移除仅服务于「历史运行表」的 `runsMap`/`fetchRuns` 调用（若无其它引用）；实现时确认无残留
  引用再删，避免误伤。

## 4. RetHistogram.vue

照 `components/quant/ShapBarChart.vue` 的 ECharts 模式（`echarts.init` / `setOption` /
`window resize` 监听 / `onUnmounted dispose`）。

```text
props: { runId: string }
state: loading / error / data(RetHistogramResult|null)
挂载/runId 变化 → fetchRetHistogram(runId) → render()
```

- 空数据（`bins.length===0`）→ 显「该运行暂无样本」占位（仿 `ShapBarChart.vue:3-6` 的 state 块）。
- ECharts option：
  - `xAxis.type='category'`，`data` = 各档标签，如 `pct(lo)~pct(hi)`（`lo*100` 取 1 位）。
  - `yAxis.type='value'`，name=`频数`。
  - `series[0].type='bar'`，`data` = `bins.map(b=>b.count)`，
    `itemStyle.color = (p)=> bins[p.dataIndex].sign==='win' ? '#18a058' : '#d03050'`。
  - `tooltip.trigger='axis'`，formatter 显「区间 [lo%, hi%) · count 笔 · 占比 x%」。
  - 可加 `markLine` 在 0 边界（盈亏分界），增强可读性（可选）。
- 颜色 token 优先用项目主题变量；ECharts 内联色值参考 `ShapBarChart.vue:67`（正负二色）。

## 5. 数据流（前端整体）

```text
SignalStatsView
  ├─ onMounted → store.fetchTests()            // SignalTestWithLatestRun[]
  ├─ <SignalStatsTable :tests :loading :runningId
  │     @run @detail @edit @delete />
  ├─ @run    → store.startRun(id)              // 轮询；完成后 fetchTests 刷新行
  ├─ @detail → selectedTest=row; showDetail=true
  ├─ @edit   → editingTest=row; showForm=true
  ├─ @delete → store.deleteTest(id)
  │
  ├─ <AppModal v-model:show="showDetail" maximizable :title="selectedTest?.name">
  │     <SignalStatsResult :test="selectedTest" />
  │        ├─ 统计卡 ← test.latestRun（无请求）
  │        ├─ tab 收益率分布 → <RetHistogram :run-id="latestRun.id" />
  │        │                     → store.fetchRetHistogram(runId)
  │        └─ tab 逐笔明细   → store.fetchTrades(runId, page, 50)
  │
  └─ <AppModal v-model:show="showForm">
        <SignalTestForm :initial-data="editingTest" @submit=... />   // 沿用现状
```

## 6. 前端硬约束自查（合并前）

- 改 import 块后立即回读文件头部验证顺序（`.claude/rules/vue3-frontend.md`）。
- `defineProps/withDefaults` 默认值禁引用 `<script setup>` 局部变量，用字面量/顶层 import。
- 自定义 `n-select` 选项类型须 `extends SelectOption`（本次若无新增 select 可忽略）。
- **合并前必跑 `vite build`**，不能只信 type-check（SFC 编译错 type-check 查不出）。
- 动到的是页面级路由组件 `SignalStatsView`，真机点开页面确认不白屏。

下一篇：[05 · 测试与验证](./05-testing-and-verification.md)
