# 01 · 现状摸底与数据流

← 返回 [index.md](./index.md)

## 1. 现状摸底（file:line 为证，均当前代码）

### 后端（能力基本具备，问题 2 几乎不用动后端；问题 1 需扩进度上报）
- **fire-and-forget run + 409**：`apps/server/src/strategy-conditions/signal-stats/signal-stats.service.ts:144-172` `triggerRun` 建 run(`status='running'`) 后 `runner.executeRun` 不 await、立即返回 runId；已有 running run（**同 test**）抛 `ConflictException`→409（`:147-152`）。
- **进度只在扫描阶段上报（问题 1 根因）**：`signal-stats.runner.ts:99-108` 仅 step3 `enumerateSignals` 的 `onProgress` 更新 `progressScanned`；step5 模拟（`:135-145`）/ step7 插库（`:171-177`）/ step8 completed（`:181-196`）**都不上报**。
- **落库顺序**：`runner.ts:171-196` 先分批插全量 trade（step7）→ 再标 completed（step8），故 `completed` ⟺ 全量 trade 已落库。
- **批量模拟结构**：`signal-stats.simulator.db.ts:75-208` `simulateSignalsBatched`，按 tsCode 分组 → `mapWithConcurrency(tsCodes, concurrency, perTsCode)`（`:206`），`perTsCode`（`:94-204`）每组返回 `SimulationOutcome[]`。**当前无任何进度回调**。
- **批量插库结构**：`runner.ts:205-225` `insertTradesBatched`，`BATCH=200` 串行 `tradeRepo.save`（40 万 ≈ 2000 批，数十秒）。
- **真值接口**：`getRunProgress(testId)` 返最近一次 run 完整实体（`service.ts:179-187` → controller `:89-92` `GET /api/signal-tests/:id/run/progress`）；`findAll()` DISTINCT ON 给每 test 附 `latestRun`（`service.ts:73-94` → controller `:69-72` `GET /api/signal-tests`）。
- **进度列**：`apps/server/src/entities/strategy/signal-test-run.entity.ts:22-26` `progress_scanned` / `progress_total`（均 `int`）。

### 前端（缺陷集中在「恢复轮询」「按钮态」「阶段文案」）
- **内存轮询 + 单值 runningId**：`apps/web/src/stores/signalStats.ts:16` `runningId`（刷新即丢）；`:61-107` `startRun` → `triggerRun` 后每 500ms `getRunProgress`→`patchLatestRun`（`:56-59`）；`:74-79` 终态停；`:80-87` **catch 一次异常即 clearInterval + runningId=null**（闪断永久停）；`:91-100` 10min 硬超时。
- **lastPollError 无处展示**：`:18` 定义、`:128` 导出，但 View/Table/Result 均未引用。
- **进页面不恢复轮询**：`SignalStatsView.vue:147-149` `onMounted` 只 `fetchTests`；`/signal-stats` 不在 keep-alive（`components/layout/Layout.vue:8` 只 `include="SymbolsView"`），每次进都全新 mount（用 `onMounted` 即可，无需 `onActivated`）。
- **运行按钮基于内存 runningId**：`SignalStatsTable.vue:29-33` props 含 `runningId`；`:244-245` `isThisRunning=runningId===row.id`、`anyRunning=runningId!==null`；`:251-261` 运行按钮 `loading=isThisRunning`、`disabled=anyRunning`。刷新后 `runningId=null` → 正跑的按钮可点 → 撞 409。
- **详情纯由 `props.test.latestRun` 驱动**：`SignalStatsResult.vue:187` `latestRun=computed(()=>props.test.latestRun)`；running 区 `:14-27`（`progressPct=:214-218`）、failed `:30-38`、completed `:40-150`。store.tests 被持续 patch 时详情自动从进度区切指标——问题只在「没人 patch」。
- **类型定义**：`apps/web/src/api/modules/strategy/signalStats.ts:40-60` `SignalTestRun`（前端本地，非 shared-types）；`:76` `SignalTestWithLatestRun = SignalTest & { latestRun: SignalTestRun | null }`。

## 2. 端到端数据流（目标态）

```text
后端 runner.doExecute（异步 fire-and-forget，已具备）
 step1  set phase='scanning', progress_total=交易日数
 step3  枚举信号 ──onProgress──▶ progress_scanned 逐日递增
 step5  进入: set phase='simulating', progress_total=signals.length, progress_scanned=0
        simulateSignalsBatched ──onGroupDone(组信号数)──▶ 内存累加
                               ──setInterval ~1.5s 节流──▶ update progress_scanned
 step7  进入: set phase='writing', progress_total=trades.length, progress_scanned=0
        insertTradesBatched ──每 N 批节流──▶ update progress_scanned
 step8  status='completed'（此后前端不再看 phase）
            │
            ▼  DB signal_test_run { status, phase, progress_scanned, progress_total, ... }
            │
前端 store：单条 interval(2s) 轮询所有 latestRun.status==='running' 的 test
   GET /signal-tests/:id/run/progress ─▶ patchLatestRun ─▶ tests[i].latestRun（响应式）
            │
            ▼
  Result.vue(running): <SignalStatsRunProgress> = n-steps 步骤条(phase 高亮) + 当前步进度条
  Table.vue: 运行按钮 disabled/loading ← row.latestRun?.status==='running'（后端真值，per-test）
  View/Table 顶部: lastPollError 非空 → n-alert 提示
```

## 3. phase 状态机

```text
            进入 step1            扫描完→进 step5         模拟完→进 step7        插库完→step8
 (null) ──────────────▶ scanning ──────────────▶ simulating ──────────────▶ writing ──────────▶ completed
                          │                          │                          │                (phase 不再读)
   每阶段同时重写 progress_total = 该阶段总量(交易日/信号数/trade行数)
   progress_scanned 在每阶段进入时归 0，再单调递增到 total
                          └──────────── 任一步抛异常 ────────────┘
                                              ▼
                                   status='failed'（phase 停在当时值，前端只看 status）
```

**前端读法**：只在 `status==='running'` 时按 `phase` 决定步骤条高亮 + 文案；`phase===null`（存量旧 run / 尚未进 step1）降级为单进度条「扫描中 X/Y」。`completed/failed` 不读 phase。

> 注：新 run 的 `phase=null` 仅存在于 step1 执行前的**极短**窗口（step1 是 runner 首步，通常跨不过 1 次 2s 轮询），稳定停在 null 的只有**存量历史 run**——降级渲染主要为兼容存量，无需对新 run 做额外防御。

→ 后端实现见 [02-backend.md](./02-backend.md)；前端实现见 [03-frontend.md](./03-frontend.md)。
