# 03 · 前端改动

← 返回 [index.md](./index.md) ｜ 上一篇 [02-backend.md](./02-backend.md)

涉及 4 个改文件 + 1 个新建子组件。核心：弃 `runningId`、改单条全局轮询器、删 10min 超时、补 `lastPollError` 展示、running 区改 n-steps 步骤条。

## 1. api 类型：`api/modules/strategy/signalStats.ts`

`SignalTestRun`（`:40-60`）加字段（与后端实体一致）：
```ts
export interface SignalTestRun {
  // ...existing...
  phase: 'scanning' | 'simulating' | 'writing' | null
}
```
其余 api 函数不变（`getRunProgress` `:123-126`、`findAll` `:103-105` 已够用）。

## 2. store：`stores/signalStats.ts`（单轮询器改造）

**删除**：`runningId` ref（`:16`）+ 导出（`:126`）；`startRun` 里旧的 per-call `setInterval`（`:67-88`）与 10min `setTimeout`（`:91-100`）。
**保留**：`lastPollError`（`:18`）、`patchLatestRun`（`:56-59`）。

新增模块级（`defineStore` 闭包内）轮询状态与函数：

```ts
let pollTimer: ReturnType<typeof setInterval> | null = null
let consecutiveFailures = 0
const POLL_INTERVAL = 2000
const MAX_CONSECUTIVE_FAILURES = 5   // 连续全失败护栏，防后端挂了无限轮询

const isRunning = (t: SignalTestWithLatestRun) => t.latestRun?.status === 'running'

async function pollOnce() {
  const runningTests = tests.value.filter(isRunning)
  if (runningTests.length === 0) { stopPolling(); return }
  let anyFail = false
  for (const t of runningTests) {
    try {
      const run = await signalStatsApi.getRunProgress(t.id)
      patchLatestRun(t.id, run)
    } catch (err) {
      anyFail = true
      lastPollError.value = err instanceof Error ? err.message : '轮询进度失败'
      // 不 clearInterval：长 run 网络抖动不该永久断轮询，下一轮重试
    }
  }
  if (anyFail) {
    if (++consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) stopPolling()
  } else {
    consecutiveFailures = 0
    lastPollError.value = null      // 一轮全成功才清错
  }
}

function ensurePolling() {
  if (pollTimer) return
  if (!tests.value.some(isRunning)) return
  consecutiveFailures = 0
  pollTimer = setInterval(() => { void pollOnce() }, POLL_INTERVAL)
}

function stopPolling() {
  if (pollTimer) { clearInterval(pollTimer); pollTimer = null }
}

/** 供 View 进页面调用：fetchTests 之后若有 running 就启轮询。 */
function resumeAllPolling() { ensurePolling() }
```

`startRun` 改为（触发后立即拉一次让该 test 变 running，再启轮询）：
```ts
async function startRun(id: string) {
  lastPollError.value = null
  try {
    const { runId } = await signalStatsApi.triggerRun(id)
    // 立即拉一次 progress，让 latestRun 立刻变 running（按钮禁用 + 进度区即时显示），不等下一轮
    const run = await signalStatsApi.getRunProgress(id)
    patchLatestRun(id, run)
    ensurePolling()
    return { runId }
  } catch (err) {
    // 透传后端原始信息（如 409「该方案已有运行中的任务」），别统一吞成通用文案。
    // 不写 lastPollError（那是轮询错通道，避免混淆）。View 的 handleRun（源 :86-92）
    // catch 后应改为 message.error(err?.message ?? '启动运行失败') 展示具体原因。
    throw err instanceof Error ? err : new Error('启动运行失败')
  }
}
```

导出表（`:124-138`）：**去掉** `runningId`；**保留** `lastPollError`（View 读取并可 `@close` 置 null，须仍在导出表中，别随 runningId 一起删）；**加** `resumeAllPolling`、`stopPolling`（`pollOnce`/`ensurePolling` 内部用，可不导出）。

> **行数**：store 现 140 行，改造后预计 ~180 行，仍远低于 500 红线。

## 3. View：`SignalStatsView.vue`

- 模板里 `<SignalStatsTable>` **删** `:running-id="store.runningId"`（`:14`）。
- 顶部加 `lastPollError` 提示（`n-card` 内、表格上方）：
  ```vue
  <n-alert v-if="store.lastPollError" type="warning" closable :bordered="false"
           style="margin-bottom: 12px" @close="store.lastPollError = null">
    进度轮询出现问题：{{ store.lastPollError }}
  </n-alert>
  ```
- `onMounted`（`:147-149`）改：
  ```ts
  onMounted(async () => {
    await store.fetchTests()
    store.resumeAllPolling()        // 有 running 就恢复轮询
  })
  onUnmounted(() => store.stopPolling())   // 离开页面清 timer 防泄漏
  ```
  （`import { onUnmounted } from 'vue'`。`/signal-stats` 不在 keep-alive，无需 onActivated。）

## 4. Table：`SignalStatsTable.vue`

- props（`:29-33`）**删** `runningId`。
- 操作列（`:243-261`）按钮态改后端真值（**per-test 互斥**，对齐后端只对同 test 拒 409）：
  ```ts
  const isThisRunning = row.latestRun?.status === 'running'
  // 运行按钮：loading=isThisRunning，disabled=isThisRunning（仅禁它自己；允许多 test 并发跑）
  ```
  > **行为变化（已与用户确认方向 A）**：旧 `anyRunning=runningId!==null` 是「任一在跑全禁」的全局互斥；新逻辑改为「只禁正在跑的那一行」，允许多 test 并发——因后端 `triggerRun` 本就只对**同 test** 已有 running 拒 409（`service.ts:147-152`），per-test 互斥不会撞 409。
- 状态列（`:124-141`）「运行中」tag、时间列（`:214-231`）保持不变。

## 5. Result + 新建 RunProgress 子组件

`SignalStatsResult.vue` 现 **410 行**，逼近 500 红线 → 把 running 进度区（`:14-27`）**抽到新子组件** `SignalStatsRunProgress.vue`（与 Result 同级 `views/strategy/`）。

### 5a. 新建 `SignalStatsRunProgress.vue`
- props：`run: SignalTestRun`（running 态）。
- 内部按 `run.phase` 渲染 **n-steps 步骤条 + 当前步进度条 + done/total 文案**；`phase===null` 降级为旧单进度条。
- 进度百分比 `progressPct = run.progressTotal>0 ? round(progressScanned/progressTotal*100) : 0`（从 Result `:214-218` 搬入）。
- 阶段映射：
  | phase | 步骤高亮 | 文案 |
  |---|---|---|
  | `scanning` | ①扫描(进行) | 扫描交易日 {scanned}/{total} |
  | `simulating` | ①✓ ②模拟(进行) | 模拟出场 {scanned}/{total} 笔 |
  | `writing` | ①✓ ②✓ ③写库(进行) | 写入结果 {scanned}/{total} 行 |
  | `null` | —（无步骤条） | 扫描中 {scanned}/{total}（降级） |

### 5b. n-steps UX（ASCII 示意）
```text
模拟出场并写入结果中…

  ┌────────────────────────────────────────────────┐
  │  ① 扫描 ✓ ───── ② 模拟 ◉ ───── ③ 写库 ○         │   ← n-steps :current 由 phase 映射
  └────────────────────────────────────────────────┘
     模拟出场  3,200 / 16,742 笔
     [█████░░░░░░░░░░░░░░░░░░░░░░░]  19%             ← n-progress :percentage=progressPct
                                                       processing 动画暗示「仍在干活」
```
- 用 naive-ui `<n-steps :current="stepIndex" size="small">` 三个 `<n-step>`（扫描/模拟/写库）；当前步下方放 `<n-progress :percentage :processing="true">` + done/total 文案。
- `stepIndex` 映射：scanning→1、simulating→2、writing→3（1-based，已完成步显 ✓）。

### 5c. Result.vue 改动
running 区（`:14-27`）替换为：
```vue
<SignalStatsRunProgress v-if="latestRun.status === 'running'" :run="latestRun" />
```
failed（`:30-38`）、completed（`:40-150`）不变。`progressPct` computed（`:214-218`）随进度区一起移入子组件（Result 内若无其它引用则删）。
> 抽出后 Result.vue 行数下降，子组件独立 < 150 行，均守住 500 红线。

→ 验证与任务切分见 [04-testing-and-tasks.md](./04-testing-and-tasks.md)。
