# 04 · 验证标准与任务切分

← 返回 [index.md](./index.md) ｜ 上一篇 [03-frontend.md](./03-frontend.md)

## 1. 验证标准

### 1a. 后端
- `pnpm --filter @cryptotrading/server build` 绿。
- `pnpm --filter @cryptotrading/server exec jest signal-stats`（runner / simulator / batch-equivalence 等）全绿，含新增 phase 顺序 & `onGroupDone` 累加断言（见 [02-backend.md#5-后端单测](./02-backend.md#5-后端单测)）。
- 跑 migration：`powershell apps/server/migrations/20260609_signal_test_run_phase.ps1`，验证输出列存在=1。
- **重启后端进程**（`dev` 无 `--watch` + `synchronize:false`，新列须重启才识别）。

### 1b. 前端
- `pnpm --filter @cryptotrading/web type-check` 绿。
- **`pnpm --filter @cryptotrading/web build`（vite）绿**——`.vue` 改动 + 新建懒加载链路上的子组件，type-check 查不出 SFC 编译错，必须 vite build。
- `pnpm --filter @cryptotrading/web lint:quant-lines` 不适用（signal-stats 不在 quant 目录），但仍**人工确认** Result.vue / 新子组件 ≤500 行。

### 1c. browser-driving 真机（对齐源交接文档验证标准）
走 `browser-driving` + `kimi-webbridge` skill。**evaluate code 里禁中文字面量**（用结构/ASCII 锚点）；可用 Pinia 直取触发：
`document.querySelector('#app').__vue_app__.config.globalProperties.$pinia._s.get('signalStats').startRun(testId)`。

现成大样本方案：`搬砖-03` = `d5e2036c-25b7-446f-aa3b-7b6148c95d7d`（trailing_lock 不封顶/全市场/20230101~20260531，约 16.7 万样本、~2 分钟）。查真值：
```
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT t.name, r.status, r.phase, r.progress_scanned, r.progress_total, r.sample_count, r.created_at, r.completed_at FROM signal_test_run r JOIN signal_test t ON t.id=r.test_id ORDER BY r.created_at DESC LIMIT 5;"
```

**验收清单**：
1. **问题 1（三阶段进度）**：触发大样本 run →
   - 扫描阶段步骤条停在 ①、进度条随交易日递增；
   - 扫描完**自动跳到 ②模拟**，进度条归零重新递增，文案「模拟出场 X/Y 笔」（与 DB `phase='simulating'`、`progress_scanned/total` 一致）；
   - 模拟完**自动跳到 ③写库**，文案「写入结果 X/Y 行」；
   - 全程**不再出现「100% + 扫描中」假死**；`completed` 后**自动切指标区**。
2. **问题 2（恢复轮询）**：run 进行中 **刷新页面 / 切走到别的路由再切回** →
   - 仍显示「运行中 + 步骤条 + 进度递增」（进度随后端动，与 `docker exec psql` 一致）；
   - `completed` 后**自动切指标**，无需手刷；
   - 其间该方案运行按钮 **disabled**（点不出 409）；其它未运行方案按钮可点（per-test 互斥）。
3. **超 10 分钟不假死**：用 40 万样本方案（`kdj_j_lt_*_2023-2026` 系列）跑 >10min，进度仍递增、不误报超时（旧 10min 超时已删）。
4. **lastPollError 提示**：临时断后端/造一次轮询失败，确认顶部 `n-alert` 提示出现且**轮询不永久停**（恢复后继续递增）。

## 2. 任务切分（subagent-driven-development）

按**独立文件域**切，避免并行 agent 互相覆盖。依赖：A→B（B 用 A 的列）；C→D（D 用 C 的 store 契约）；A/C 可并行起步，B 与 C/D 跨前后端无文件交集可并行。

```text
┌──────────────────────────────────────────────────────────────────────┐
│ 任务A 后端数据层        无依赖，先行                                    │
│   - entities/strategy/signal-test-run.entity.ts （加 phase 列）         │
│   - migrations/20260609_signal_test_run_phase.sql + .ps1               │
│   - 跑 migration + 重启后端                                             │
├──────────────────────────────────────────────────────────────────────┤
│ 任务B 后端进度上报      依赖 A 的 phase 列                              │
│   - signal-stats.simulator.db.ts （onGroupDone 回调）                   │
│   - signal-stats.runner.ts （三阶段 phase + 节流封装 + insert 上报）    │
│   - signal-stats.runner.spec.ts / simulator*.spec.ts （新断言）         │
├──────────────────────────────────────────────────────────────────────┤
│ 任务C 前端类型 + store  可与 A/B 并行（不碰后端）                       │
│   - api/modules/strategy/signalStats.ts （SignalTestRun.phase）         │
│   - stores/signalStats.ts （弃 runningId / 单轮询器 / 删超时 /          │
│                             lastPollError / resumeAllPolling/stopPolling）│
├──────────────────────────────────────────────────────────────────────┤
│ 任务D 前端视图          依赖 C 的 store 契约                            │
│   - views/strategy/SignalStatsView.vue （删 running-id / 恢复轮询 /     │
│                                          lastPollError alert / onUnmounted）│
│   - views/strategy/SignalStatsTable.vue （按钮态改 latestRun.status）   │
│   - views/strategy/SignalStatsResult.vue （running 区换子组件）         │
│   - views/strategy/SignalStatsRunProgress.vue （新建：n-steps 步骤条）  │
└──────────────────────────────────────────────────────────────────────┘
```

**文件域互不相交**：A=实体+migration，B=simulator+runner+spec，C=api+store，D=views/*.vue。A/C 起步并行（**C 的 `SignalTestRun.phase` 类型字面量取值须与 A 的实体 `phase` 列定义对齐**，C 起步前先看 A 的实体定义再写类型）；A 完成后 B；C 完成后 D。真机 e2e 在 A+B+C+D 全部落地、后端重启、vite build 后统一执行（单人会话串行也可，切分主要为可并行化与审查清晰）。

## 3. 硬约束清单（实现时逐条遵守）

- **后端 `dev` 无 `--watch`**：改 `apps/server` + schema 变更后**必须重启后端进程**，e2e 前确认跑最新代码。
- **schema 走 migration**（`synchronize:false`）：`.sql` + 配对 `.ps1`（docker exec），`ADD COLUMN IF NOT EXISTS` 幂等。
- **`.vue` 合并前必跑 `vite build`**：type-check（vue-tsc）查不出 SFC 编译错；动到懒加载路由 `/signal-stats` 真机点开确认不白屏。
- **单文件 ≤500 行**：Result.vue 现 410 行——running 区**必须**抽 `SignalStatsRunProgress.vue`，别在 Result 里继续堆 n-steps。
- **时间展示本地 TZ**：沿用 `formatUTCDateTime`（Table 已用）；DB 列 timestamptz。
- **不静默吞错**：轮询/启动失败透出（`lastPollError` + n-alert），别再让它默默无声。
- **不改模拟/聚合口径**：`onGroupDone` 是纯同步回调，zero-drift / batch-equivalence 单测必须仍全绿。
- **进度上报降频**：模拟阶段 setInterval ~1.5s flush、写库每 ~2000 行 flush，禁每组/每批都 `runRepo.update`（几千次 DB 往返会拖慢长 run）。
- **browser-driving**：evaluate code 禁中文字面量（PowerShell→webbridge 传输会坏，用结构/ASCII 锚点）。

## 4. 完成后

- 源交接文档 `prompts/improve-signal-stats-run-status-ux.md` 移入 `prompts/archive/`。
- 分层提交（用户偏好按子系统分 commit）：可按 任务A/B（后端）、任务C/D（前端）拆 2~4 个语义化 commit。
- 更新项目 memory `project_signal_forward_stats.md` 追加本次运行态 UX 修复。
