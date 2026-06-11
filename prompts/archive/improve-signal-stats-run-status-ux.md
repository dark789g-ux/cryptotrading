# 修复 signal-stats 运行态体验：进度条满了像卡死 + 刷新/切走丢轮询脱节

## 一句话目标

`/signal-stats` 的运行态展示要让用户**不困惑**：① run 进入「扫描完 → 模拟出场 + 写库」阶段时，别再显示「扫描中」+ 满进度条像卡死；② 刷新页面 / 切走再切回 / run 超 10 分钟 / run 是别处触发的，前端都应正确显示「运行中 + 进度递增」，完成后**自动**切指标——不再出现「后端在跑、前端却停在静态快照、还没任何提示」的脱节。

> ⚠️ 这是**交接文档，非已实现**。接手先 `/brainstorming` 跟用户敲定下方「开放问题」范围，再 `/writing-plans` + 实现，别直接动手。
> 本文档**合并并取代**原 `prompts/archive/sync-signal-stats-run-status.md`（已归档）——那份写于「列表化重构」之前，其 file:line（`runProgress` Map / `selectTest` / `fetchRuns` / Result.vue 的 fallback）**多已失效**。**一切以本文档下方核对过的当前 file:line 为准**（2026-06-09 已逐个落源头核对当前代码）。

## 背景：两个问题同源但独立（2026-06-09 浏览器实测）

重跑现成方案 `搬砖-03`（trailing_lock 不封顶 / 全市场 / 20230101~20260531 / 16.7 万样本）实测：startRun 后**扫描数十秒就到 822/822（进度条满）**，之后**满着 `running` 又持续 ≥88 秒**才 `completed`（大头花在「模拟 16.7 万笔出场 + 分批写 16.7 万行库」）；`completed` 后前端 500ms 轮询自动把详情从进度区切到指标区，**无需手刷**——前提是**轮询还活着**。

- **问题1（UX 观感，非 bug）**：进度条满 ≠ 完成。进度条只反映「扫描」一个阶段，满了之后还有不上报进度的模拟+写库阶段，用户看「100% + 扫描中 + 运行中」像卡死。
- **问题2（真脱节）**：前端「运行态 + 进度」只来自本会话 `startRun` 的内存轮询；刷新 / 切走切回 / 超 10 分钟，轮询就断了，后端仍在跑、前端却停在静态快照。本次没刷新所以没触发，但它真实存在。

## 现状摸底（file:line 为证，均为列表化重构后的**当前**代码）

### 后端：能力已具备，够用，基本不用动
- **fire-and-forget run**：`apps/server/src/strategy-conditions/signal-stats/signal-stats.service.ts:144-172` `triggerRun` 建 run(`status='running'`) 后 `runner.executeRun` **不 await**、立即返回 runId；已有 `running` run 时拒 **409**（`service.ts:147-152`）。
- **进度只在扫描阶段上报（问题1 根因）**：`signal-stats.runner.ts:99-108` 仅 step3 `enumerateSignals` 的 `onProgress` 更新 `progressScanned`；step5 模拟出场 / step6 聚合 / step7 插库（`runner.ts:135-177`）**都不上报**，progressScanned 停在 total；step8 才一次性置 `completed`（`runner.ts:181-196`）。
- **落库顺序**：`runner.ts:171-196` **先分批插全量 trade(step7) → 再标 completed(step8)**，故 `completed` ⟺ 全量 trade 已落库（无「完成瞬间读到部分 trade」的 race）。
- **后端真值随时可取（恢复轮询的现成入口）**：`getRunProgress(testId)` 返回该 test 最近一次 run 完整实体（`service.ts:179-187`）。接口 `GET /api/signal-tests/:id/run/progress`（前端 `apps/web/src/api/modules/strategy/signalStats.ts:122-125`）。
- **列表已天然带 running 真值（列表级标记不需新接口）**：`findAll()` 用 DISTINCT ON 给每个 test 附 `latestRun` 完整实体（`service.ts:73-94`）。接口 `GET /api/signal-tests`（api `signalStats.ts:102-104`）。→ 进页面 `fetchTests` 就已拿到「哪些 test 的最近 run 是 running + 当时进度」。

### 前端：缺陷集中在「恢复轮询」与「阶段文案」
- **进度只在本会话内存轮询里推进**：`apps/web/src/stores/signalStats.ts:61-107` `startRun` → `triggerRun` 后启 `setInterval` 每 500ms `getRunProgress` → `patchLatestRun`（`:67-88`，把 run patch 进 `tests[i].latestRun`，`patchLatestRun` 在 `:56-59`），status `completed/failed` 则 `clearInterval`+`runningId=null`（`:74-79`）。`runningId`（`:16`）是**内存单值、刷新即丢**。
- **10 分钟硬超时**：`signalStats.ts:91-100` `setTimeout` 到点 `clearInterval` + `runningId=null` + `lastPollError='运行轮询超时（10min）'`；此后进度停在快照、后端仍在跑 → 脱节。
- **`lastPollError` 无处展示**：`lastPollError`（`signalStats.ts:18` 定义、`:128` 导出）在 `SignalStatsView/Result/Table` **均未被引用**（已 grep 全 `web/src` 确认）→ 轮询超时/出错现在**对用户零提示**，只见进度条停住。
- **进入页面不恢复轮询**：`apps/web/src/views/strategy/SignalStatsView.vue:147-149` `onMounted` 只 `fetchTests`，**无恢复轮询逻辑**。`/signal-stats` 路由懒加载（`apps/web/src/router/index.ts:67-71`）、**不在 keep-alive include 名单**（`apps/web/src/components/layout/Layout.vue:8` 只 `include="SymbolsView"`）→ 每次进入都全新 mount + onMounted（**无需 onActivated**）。但 `fetchTests` 拿到的 `latestRun`（若 running）只是**静态快照**：列表行显示「运行中」tag（`SignalStatsTable.vue:124-142`，纯渲染 `latestRun.status`、不轮询）、详情显示进度区（`SignalStatsResult.vue:16-27`）——**进度不动、跑完不自动变 completed**。
- **运行按钮基于内存 `runningId`**：`SignalStatsTable.vue:244-261` `loading=runningId===row.id`、`disabled=runningId!==null`。刷新后 `runningId=null` → 正在跑的方案按钮恢复可点 → 点了撞后端 **409**。
- **详情结果纯由 `props.test.latestRun` 驱动（重构后已无 fallback）**：`SignalStatsResult.vue:187` `latestRun=computed(()=>props.test.latestRun)`，响应式跟随 `store.tests`；进度区 `:16-27`（`progressPct` 在 `:214-218` = scanned/total）、failed `:30-38`、completed `:41-150`。**只要 store.tests 里该 test 的 latestRun 被持续 patch，详情会自动从进度区切到指标**——问题只在「没人 patch」（无轮询）。

## 候选方向 + 权衡（供 brainstorming，非最终）

### 问题1：进度条满了像卡死
- **轻量（建议起点，只动前端）**：`SignalStatsResult.vue:16-27` 进度区——当 `progressScanned===progressTotal && status==='running'` 时，label 从「扫描中 X/Y」改为「**正在模拟出场并写入结果…（已扫完 X 个交易日）**」，`n-progress` 加 `:processing="true"`（满进度条带流动动画，暗示仍在干活）。改动 <20 行，直接消除「卡死」误解。
- **完整（可选，动后端）**：runner 给 step5/step7 也上报进度（扩 progress 语义为加权三阶段，或加 `phase` 字段）。需改 runner 上报点 + 可能加 DB 列 + 实体 + 前端进度计算，工作量大数倍、收益有限。**默认不做，除非用户要**。

### 问题2：刷新/切走丢轮询脱节
- **方向 A（最小闭环，建议）**：
  1. 把 `startRun` 里「轮询」部分抽成 `resumePolling(testId)`（**不** `triggerRun`，只 `getRunProgress`→`patchLatestRun`→终态停）。
  2. `SignalStatsView.vue` 在 `fetchTests` 之后，对 `tests` 里 `latestRun?.status==='running'` 的 test 调 `resumePolling` 恢复轮询。
  3. **删 10min 硬超时**（`signalStats.ts:91-100`），终止只看后端 status 到 `completed/failed`；页面销毁时清掉 interval 防泄漏（在 store 维护 interval 句柄并在卸载清，或改「单 interval 轮询所有 running」）。
  4. 运行按钮 `disabled/loading` 改为基于 `row.latestRun?.status==='running'`（后端真值）而非内存 `runningId`，避免刷新后可点撞 409。
- **多 running 并发**：`findAll` 已支持每 test 各自 latestRun、Table 已能渲染多个 running；`runningId` 单值是运行按钮的历史约束。若要支持「同时多个 running 各自轮询」，`runningId` 改 Set 或弃用、一律用 `latestRun.status` 判断。
- **轮询模型**：现状每个运行 test 一条 500ms interval。多 running 时建议改「单条 interval 轮询所有 running test」或降频（1~2s），避免 N 条高频轮询。

## 开放问题（接手先与用户敲定）
1. 问题1 只做轻量（文案 + processing 动画）？完整阶段进度（动后端）做不做？
2. 恢复轮询范围：进页面恢复**所有** running test（列表级，findAll 已支持），还是只恢复「打开详情的那个」？
3. `runningId` 单值 → 改 Set / 还是改用 `latestRun.status` 判按钮态、弃 `runningId`？
4. 10min 超时：直接删 / 保留很大上限 / 改显示「已运行 N 分钟」？
5. `lastPollError` 现在没展示——要不要补展示（轮询出错给提示），还是确认丢弃？
6. 轮询频率：恢复后维持 500ms，还是降到 1~2s（长 run 下 500ms 偏密）？

## 硬约束 / 项目规范
- **后端 `dev` 无 `--watch`**：改 `apps/server` 必须重启后端进程才生效；e2e 前先确认跑的是最新代码（本任务大概率**纯前端**，若动 runner 才涉及）。
- **前端 `.vue` 合并前至少跑一次 `pnpm --filter @cryptotrading/web build`（vite）**：`type-check`（vue-tsc）查不出 SFC 编译错。动到懒加载路由 `/signal-stats` 真机点开确认不白屏。
- **单文件 ≤500 行**：`SignalStatsResult.vue` 现 **409 行**、`SignalStatsView.vue` 160、`signalStats.ts` 139——加逻辑注意拆分。
- **时间展示本地 TZ**：运行时间用 `formatUTCDateTime`（Table 已用，`SignalStatsTable.vue:229/234`）；DB 列 timestamptz。详见 `.claude/rules/datetime.md`。
- **不静默吞错**：轮询失败要透出（对应开放问题 5，别再让 `lastPollError` 默默无声）。
- **真机验证走 `browser-driving` + `kimi-webbridge` skill**；**evaluate code 里别塞中文字面量做匹配**（PowerShell→webbridge 传输会坏，用结构 / ASCII 锚点）。可用 **Pinia 直取调 action** 复现：`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('signalStats').startRun(testId)`（见 `browser-driving` lessons-learned 2026-06-09 条）。

## 验证标准（browser-driving 真机）
1. 触发一个大样本长 run（下方现成 `搬砖-03`=`d5e2036c-25b7-446f-aa3b-7b6148c95d7d`，16.7 万样本、约 2 分钟；或 `kdj_j_lt_*_2023-2026` 系列 40 万样本更耗时）：
   - **问题1**：进度条到 100% 后，文案显示「正在模拟出场/写入…」+ 进度条带流动动画，不再静态「扫描中」；`completed` 后自动切指标。
   - **问题2**：run 进行中**刷新页面 / 切走再切回**，仍显示「运行中 + 进度递增」（进度随后端动，与 `docker exec psql` 查到的 `signal_test_run.status/progress_scanned` 一致），`completed` 后**自动**切指标无需手刷；其间该方案运行按钮 disabled（点不出 409）。
   - run 超 10 分钟（用 40 万样本方案）进度仍递增、不假死、不误报超时。
2. `pnpm --filter @cryptotrading/web build` 通过；若动后端则 `pnpm --filter @cryptotrading/server build` + 重启进程。

## 复现素材 / 前序进度
- 查 run 真值（注意列名：`completed_at`，无 started/finished）：
  ```
  docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT t.name, r.status, r.progress_scanned, r.progress_total, r.sample_count, r.created_at, r.completed_at FROM signal_test_run r JOIN signal_test t ON t.id=r.test_id ORDER BY r.created_at DESC LIMIT 10;""
  ```
- 现成大样本方案（trailing_lock 不封顶/全市场/20230101~20260531）：`搬砖-03`=`d5e2036c-25b7-446f-aa3b-7b6148c95d7d`。
- 2026-06-09 诊断结论：进度条满 ≠ 完成是**正常中间态、非 bug**；脱节问题（问题2）本次未触发（没刷新）。详见项目 memory `project_signal_forward_stats.md` 的「进度条满了却没结束」段。

## 待续
接手 → `/brainstorming` 敲开放问题 → `/writing-plans` → 实现（前端为主：问题1 轻量 + 问题2 方向 A）→ `browser-driving` 真机验证 → 完成后本文档移入 `prompts/archive/`。
