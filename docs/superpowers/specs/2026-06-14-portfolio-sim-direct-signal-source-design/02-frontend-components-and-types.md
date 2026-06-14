# 02 · 前端组件拆分与类型

返回:[index.md](./index.md)

## 1. 组件拆分(硬约束:单 `.vue` ≤ 500 行)

现状行数(已核实):`PortfolioSimSourceRow.vue` **369**、`PortfolioSimCreateModal.vue` **424**、
`SignalTestForm.vue` **491**(已逼近上限,但作为子组件**内嵌不增宿主行数**)。
直接往 SourceRow 加 A/B 必破 500 → 按「独立文件域」拆,让后续多 agent 各改不相交文件。

```text
apps/web/src/components/portfolio-sim/
├─ PortfolioSimCreateModal.vue        现 424 → 基本不动(仍 v-for 渲染 SourceRow)
├─ PortfolioSimSourceRow.vue          瘦身:保留 label/仓位/maxPos/exposureCap/
│                                       rankSpec/sizing,把来源选择委托给 RunPicker;
│                                       嵌入 NewSourceModal 触发点。目标 <500
├─ PortfolioSimSourceRunPicker.vue    ★新 路径A+来源方式切换:
│                                       三选一来源方式 / 选方案 / 历史run二级下拉 /
│                                       手填uuid / 只读条件摘要 / B 完成后状态展示
├─ PortfolioSimNewSourceModal.vue     ★新 路径B 子弹窗:整体内嵌 SignalTestForm,
│                                       托管 create+triggerRun,emit {runId, testId}
└─ composables/usePortfolioSimSourceRuns.ts   ★新
      listRuns(testId) 懒加载+缓存 · getRunProgress(testId) 轮询(2s) · 生命周期清理
```

- **手填 uuid** 老路逻辑搬进 RunPicker 的第三来源方式,行为不变(含 `.trim()`)。
- **子弹窗由 RunPicker/SourceRow 内部托管**,不灌进 CreateModal(防其膨胀)。
- Modal 一律复用 `@/components/common/AppModal.vue`,按钮放 `#actions` slot
  (见 [.claude/rules/vue3-frontend.md](../../../../.claude/rules/vue3-frontend.md) 「Modal 统一复用 AppModal」)。

**NewSourceModal 内嵌 `SignalTestForm` 的提交机制(关键,勿写错)**:
`SignalTestForm` 无内部提交按钮,通过 `defineExpose({ submit: handleSubmit })`(`SignalTestForm.vue:484`)
暴露提交方法,`@submit(dto)` 只在外部调用 `formRef.value?.submit()` 后才触发(内部先跑校验 `:417`)。故 NewSourceModal 须:
1. 持 `SignalTestForm` 模板 ref(`const formRef = ref()`);
2. AppModal `#actions` 的「创建并运行」按钮 `onClick` 调 `formRef.value?.submit()`(触发校验);
3. 在 `@submit` 回调里拿到 `CreateSignalTestDto` → 走 `create + triggerRun` → emit `{runId, testId}` 回 RunPicker。

现成对照实现:`SignalStatsView.vue:66-70`(`ref + @submit`)、`:176`(按钮调 `formRef.value?.submit()`)。
**绝不能**在 `#actions` 按钮里自己拼 DTO——会绕过 `SignalTestForm` 的全部表单校验。

**嵌套弹窗**:NewSourceModal 是开在「新建组合 AppModal」内部的第二层 AppModal。须:子 AppModal 独立 `show` 控制、
`mask-closable=false` 防点遮罩误关外层;真机 e2e 验嵌套层级(剧本② 开子弹窗时确认外层不被关、ESC/遮罩行为符合预期)。

## 2. composable 职责(`usePortfolioSimSourceRuns.ts`)

单一目的、可独立测试。对外接口约意:

```text
usePortfolioSimSourceRuns()
  ├─ loadRuns(testId)        → 调 listRuns,缓存按 testId;返回 SignalTestRun[]
  ├─ latestCompleted(runs)   → 取最新 completed run(A 默认值)
  ├─ startPolling(testId, onUpdate)  → setInterval 2s 调 getRunProgress;
  │                                     status∈{completed,failed} 即 stop
  └─ stopPolling(testId)     → clearInterval;组件 onUnmounted/关弹窗统一调
```

- 轮询**仅 B 用**(A 只选 completed);completed/**failed**/卸载/关弹窗/切换来源方式即 `clearInterval`,防泄漏。
  > ⚠️ 失败态枚举是 **`'failed'`** 不是 `'error'`(`signalStats.ts:69` / `signal-test-run.entity.ts:20` / `signal-stats.runner.ts:104`)。
  > 写 `status === 'error'` 永不命中 → 失败 run 死循环轮询且不显错。错误文案读 `errorMessage` 字段(字段名正确)。
- **节拍/失败容忍与既有保持一致**:项目已有 `usePortfolioSimStore` 模块级单轮询器(2s、连续 N 次失败才停、终态停),
  signalStats store 同构。本 composable 因需**按源行隔离作用域**默认新建(不复用全局态耦合的 `resumeAllPolling`),
  但**节拍固定 2s、终态(completed/failed)即停、连续失败容忍策略须与既有一致**,避免实现者各写一套。
- **进度字段勿串用**:signal-test run 用 `progressScanned/progressTotal`(`signalStats.ts:73-74`);
  portfolioSim run 用的是 `progressDone/progressTotal`。照搬 portfolioSim store 会错用 `progressDone`。

## 3. 类型镜像(无 shared-types 改动)

本特性**不新增/不改任何 API 契约**,故 `packages/shared-types` 不动。前端复用现有类型:

- `SignalTestRun`(`apps/web/src/api/modules/strategy/signalStats.ts`)— A 的 run 列表、B 的进度轮询返回。
- `SignalTestWithLatestRun` — `findAll()` 返回,取方案条件摘要。
- `CreateSignalTestDto` — B 子弹窗 `SignalTestForm` 提交体(原样)。
- `PortfolioSimSource` — 源行模型,**字段不变**(仍含 `runId`);`testId` **不进 source 模型、不进 DTO**。

**状态归属表(单一持有者,防状态分裂)**:`RunPicker` 是来源选择的唯一状态宿主——
持有 `sourceMethod/schemeId/testId/run列表/进度态`,内部用 `usePortfolioSimSourceRuns` 跑轮询;
只向上 `emit('update', { runId })` 把**契约字段**给 SourceRow。`testId` 全程**不出 RunPicker**。

```text
字段            持有组件        是否进 DTO   用途
runId           SourceRow←emit  ✅(契约)     最终提交;loader 用它查逐笔
sourceMethod    RunPicker        ✗            三态来源方式(UI)
schemeId        RunPicker        ✗            选方案
testId          RunPicker        ✗            查 listRuns / 轮询 getRunProgress / 摘要
run列表/进度态  RunPicker        ✗            A 下拉 / B 运行中展示
```

> NewSourceModal 完成后 `emit('created', { runId, testId })` 回**给 RunPicker**(不是 SourceRow);
> RunPicker 收下 testId 自用、再把 runId emit 给 SourceRow。

> 自定义 `<n-select :options>` 选项接口须 `extends SelectOption`
> (见 vue3-frontend 「Naive UI 自定义选项类型」),避免 `vue-tsc` 判别联合报错。

## 4. 行数预算自检(实现期)

- SourceRow 瘦身后应明显 < 500(把来源选择整块迁出后预计降到 ~250-300)。
- 三个新文件各自 < 500(RunPicker 预计最重,需控量;过重再把「条件摘要」抽小组件)。
- **`lint:quant-lines` 已确认覆盖** `src/components/portfolio-sim/**` 与 `src/views/strategy/**`
  (见 `apps/web/scripts/check-quant-vue-line-count.mjs:34-35` 的 ROOTS),故 RunPicker/NewSourceModal
  受 CI 行数门禁强制,**必须 < 500**;合并前跑 `lint:quant-lines`。
