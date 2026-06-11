# 让信号前向统计前端展示与后端同步的 run 状态

## 一句话目标

`/signal-stats` 页面的「运行中 / 进度 / 完成」状态，应以**后端 run 真值**为准实时展示——刷新页面、切走再切回、运行超过 10 分钟、甚至 run 是别处触发的，前端都应正确显示「运行中 + 进度递增」，完成后自动切到指标，不再出现「后端在跑、前端却显示超时或只剩历史结果」的脱节。

> ⚠️ 这是**交接文档**，不是已实现。接手后请先 `/brainstorming` 与用户敲定下面「开放问题」的范围，再 `/writing-plans` + 实现。别直接动手。

## 问题现象（用户视角）

触发一个耗时较长的 run（信号量大 / 区间长，>10 分钟），会出现：

- 跑了 10 分钟后，UI 进度条不再动、提示「运行轮询超时（10min）」，但后端其实还在跑、最终会把结果落库；
- 刷新页面 / 切到别的方案再切回来，正在跑的 run 在结果区「消失」，只显示历史已完成的那次（左侧历史表里那行 `运行中` tag 是静态快照，进度不动、跑完也不自动变）；
- 同一方案这时点「运行」会撞后端 `409 ConflictException`（`该方案已有运行中的任务`）。

## 现状摸底（file:line 为证，别凭模块名猜）

**根因一句话**：前端的「运行态 + 进度」只来自**本会话 `startRun` 的内存轮询**，没有把后端 `getRunProgress`（随时可取的真值）用在「进入页面 / 选中方案」的状态恢复上。

### 数据流与缺陷点

1. **进度真值入口（后端，已具备，未被充分利用）**
   - `apps/server/src/strategy-conditions/signal-stats/signal-stats.service.ts:154-162` `getRunProgress(testId)` 返回该 test **最近一次 run**（`createdAt DESC`），含 `status` / `progressScanned` / `progressTotal` / 完成后的全部指标。**这就是「后端真实状态」的现成接口**，前端 GET `/api/signal-tests/:id/run/progress`（`apps/web/src/api/modules/strategy/signalStats.ts:121-123`）。
   - run 是 fire-and-forget 后台任务：`service.ts:119-147` `triggerRun` 建 `run(status='running')` 后 `runner.executeRun` **不 await**，立即返回 runId；`signal-stats.runner.ts:55-66 / 68-183` 跑完把 `status='completed'`（或 `failed`）+ 指标落库。**后端完全独立于前端是否在看。**
   - 并发规则：同一 test 已有 `running` run 会被拒（`service.ts:122-127`）；**不同 test 之间无锁**，可并发跑。

2. **前端进度只在内存轮询里更新（缺陷核心）**
   - `apps/web/src/stores/signalStats.ts:16` `runProgress = ref<Map<testId, Progress>>`，**只在** `startRun` 的 `setInterval` 里被写（`signalStats.ts:61-80`，每 500ms 一次）。
   - `signalStats.ts:17` `runningId` 是前端内存单值，刷新即丢。
   - **10 分钟硬超时**：`signalStats.ts:82-92` `setTimeout(10*60*1000)` 到点 `clearInterval` + `runningId=null` + `lastPollError='运行轮询超时（10min）'`。此后 Map 停在 10 分钟快照，后端仍在跑 → 前后端脱节。

3. **结果组件的 fallback 把「运行中」吞成「只看历史」**
   - `apps/web/src/views/strategy/SignalStatsResult.vue:169-176` `latestProgress`：优先 `store.runProgress.get(testId)`（本会话轮询写的）；**Map 里没有该 testId 条目时**（刷新 / 别处触发 / 超时后），直接 fallback 到 `runsMap` 里第一个 `completed` 的历史 run → **完全不渲染「running + 进度」**（进度区 `:4-16` 只在 `latestProgress.status==='running'` 时显示，而 fallback 给的是 completed）。

4. **进入页面 / 选中方案不主动同步后端状态**
   - `apps/web/src/views/strategy/SignalStatsView.vue:125-129` `selectTest` 只 `store.fetchRuns(testId)`（拉历史 run 列表，静态）；`:186-188` `onMounted` 只 `fetchTests`。**没有调 `getRunProgress` 判断最近 run 是否 running、也不恢复轮询。**
   - 左侧历史表（`SignalStatsResult.vue:112-120`）会显示 running 行（`status` tag，`:294-313`），但**不轮询刷新**——进度不动、跑完不自动变。

5. **运行按钮的串行假设**
   - `SignalStatsView.vue:42-48` 运行按钮 `:loading="store.runningId===selectedTestId"` `:disabled="store.runningId!==null"`——基于内存 `runningId`。刷新后 `runningId=null`，正在跑的方案按钮恢复可点，点了撞 409。

## 候选方向 + 权衡（供 brainstorming，非最终）

**核心思路**：让「运行态 + 进度」以后端 `getRunProgress` 为唯一真值源，而非本会话内存轮询。

- **方向 A（最小闭环，建议起点）**
  1. `selectTest` / `onMounted` 时对选中 test 调 `getRunProgress`，`status==='running'` → 恢复 `runningId` + 启动轮询，把进度写进 `runProgress` Map（复用现有渲染）。
  2. 去掉 10 分钟硬超时（`signalStats.ts:82-92`），轮询终止条件改为**后端 status 到 `completed`/`failed`**；页面关闭定时器自然销毁，无泄漏。
  3. 确保 fallback 逻辑（`SignalStatsResult.vue:169-176`）在「后端 running」时优先展示 running，而非历史 completed。
  - 代价：每个选中方案一条轮询；够用、改动小。

- **方向 B（列表级可见）**：左侧列表每个 test 项显示 running 标记。需要批量知道「哪些 test 有 running run」——前端逐个 `getRunProgress` 是 N+1，建议后端加一个批量接口（`findAll` 附带各 test 最近 run 摘要，或新 endpoint）。

- **方向 C（对齐项目 SSE 范式）**：项目同步任务 / quant jobs 都用 SSE 推进度（见 `CLAUDE.md` 数据流要点 + `apps/web/src/views/quant/README.md`）。但 signal-stats run 是后台 fire-and-forget，改 SSE 要后端维护 run→client 事件流，改动大。**轮询大概率已够用，SSE 可能过度**——需 brainstorming 定。

## 开放问题（接手先与用户敲定）

1. **范围**：只做「选中方案时同步当前 run 状态」（方向 A），还是要左侧列表级 running 标记（方向 B）？
2. **轮询 vs SSE**：保持轮询（改终止条件）还是对齐项目 SSE 范式（方向 C）？
3. **10 分钟超时**：直接删，还是保留一个很大的上限 / 显示「已运行 N 分钟」而非「超时」？
4. **并发多 run**：现在能并发触发多个不同 test 的 run，前端 `runningId` 是单值。要不要支持同时展示多个 running？还是仍「一次选一个看」、只把单值假设改成「按 test 各自判断」？
5. **后端是否需要新接口**：列表级标记（方向 B）若要避免 N+1，需后端批量返回各 test 最近 run 状态——要不要做。

## 硬约束 / 项目规范

- **单文件 ≤500 行**：`SignalStatsResult.vue` 已 440 行，逼近上限；新增 UI 注意拆分（`lint:quant-lines` 只管 quant 目录，但本规范全局适用）。
- **后端 `dev` 无 `--watch`**：改 `apps/server` 必须重启后端进程才生效；端到端验证前先确认跑的是最新代码。
- **前端 `.vue` 改动合并前至少跑一次 `pnpm --filter @cryptotrading/web build`（vite）**，不能只信 `type-check`（vue-tsc 查不出 SFC 编译错）。动到共享组件 / 懒加载路由要真机点开确认不白屏。
- **时间展示用本地 TZ**：日历日 / 运行时间用 `getFullYear/getMonth/getDate`（参考 `SignalStatsResult.vue:289-292`）；DB 列 timestamptz。详见 `.claude/rules/datetime.md`。
- **不要静默吞错**：轮询失败要透出（现 `signalStats.ts:72-79` 有 `lastPollError`，别去掉）。
- 改前端走 `browser-driving` + `kimi-webbridge` skill 真机验证；**evaluate code 里别塞中文字面量做匹配**（PowerShell→webbridge 传输会坏，用结构性 / ASCII 锚点）。

## 验证标准

1. 触发一个 >10 分钟的长 run（用下方现成方案，或新建一个长区间方案触发），在 UI 上：
   - 超过 10 分钟，进度条仍递增、不显示「超时」；
   - 刷新页面 / 切走再切回该方案，仍显示「运行中 + 当前进度」，且与 `docker exec ... psql` 查到的 `signal_test_run.status` / `progress_scanned` 一致；
   - 后端 `completed` 后，UI **自动**切到指标展示，无需手动刷新。
2. 真机端到端（browser-driving）：DB `status='running'` 时 UI 必须显示运行中且进度对齐 DB；不得再出现「后端 running、前端只剩历史结果」。
3. `pnpm --filter @cryptotrading/web build` 通过；改后端则 `pnpm --filter @cryptotrading/server build` + 重启。

## 前序进度 / 复现素材

- 本需求源于一次真实任务：通过前端建了 4 个长区间方案（`kdj_j_lt_-10/0/10/20_2023-2026`，全市场、T+1 持有 1 天、区间 `20230101~20260531`，各 814 个 SSE 交易日）并**并发触发 4 个 run**——正好暴露本 bug（10 分钟后前端显示超时、后端继续跑）。
- 查当前 run 状态：
  ```
  docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT t.name, r.status, r.progress_scanned, r.progress_total, r.sample_count FROM signal_test_run r JOIN signal_test t ON t.id=r.test_id WHERE t.date_end='20260531' ORDER BY (t.buy_conditions->0->>'value')::numeric;"
  ```
- 若接手时这些 run 已 `completed`（不再能复现 running 态），重新对任一长区间方案触发 run 即可（前端选中方案点「运行」，或 POST `/api/signal-tests/:id/run`）。信号量大的 `kdj_j_lt_20_2023-2026` 最耗时，适合做 >10 分钟复现。

## 待续

接手 → `/brainstorming` 敲定开放问题范围 → `/writing-plans` → 实现 → browser-driving 真机验证 → 完成后本文档移入 `prompts/archive/` 或删除。
