# 加前端枚举渲染点守门（防 exitMode/exitReason 新增值漏渲染点）

> 本文自包含，可整段贴给全新会话接手。

## 一句话目标
从机制上堵住"新增 `exitMode`/`exitReason` 枚举值时漏掉某个渲染点 → 显示 fallback/原始串"这类 bug——它单测 + vite build 全测不出，只有真机 e2e / 人工才发现。

## 现状摸底（file:line 为证，本次 phase_lock 漏了 3 个 exitMode 渲染点，均已修，作反面教材）
- 漏过（已修）：
  - `apps/web/src/views/strategy/SignalStatsTable.vue`（出场方式列 NTag）—— 曾落 strategy 兜底 `条件出场(≤?)`（commit 2b97963）。
  - `apps/web/src/views/strategy/SignalStatsResult.vue`（`exitModeLabel`）—— 同上（commit 2b97963）。
  - `apps/web/src/views/strategy/SignalStatsView.vue:116`（`exitModeLabel`，"导入方案"下拉）—— 曾显示原始串 `phase_lock`（commit 7913d91）。
- 当时正确、可作参照：
  - `apps/web/src/components/strategy/SignalTestConfigPanel.vue:113`（`exitModeText`）。
  - `apps/web/src/components/strategy/signalStatsFormatters.ts:20`（exitReason 标签，已含 `phase_lock_stop`/`phase_lock_ma5`）。
- 枚举全集：`apps/web/src/api/modules/strategy/signalStats.ts` 的 `SignalTestExitMode = 'fixed_n'|'strategy'|'trailing_lock'|'phase_lock'`；exitReason 含 `phase_lock_stop`/`phase_lock_ma5` 等。
- 共 4 处 exitMode → 标签的分散映射（Table/Result/View/ConfigPanel），各自硬编码、易漏。

## 已定方向（待敲定）
- **收敛**：把分散的 `exitMode → 标签` / `exitReason → 标签` 映射收敛到**单一 source**（如 `signalStatsFormatters.ts` 导出 `exitModeLabel`），各组件复用 —— 根治多副本漏网。
- **守门测试（更轻）**：加 vitest，遍历 `SignalTestExitMode` / exitReason 全集，断言经每个 label 函数都得到**非 fallback / 非原始串**的标签（故意删某分支 → 测试变红）。
- 建议：能收敛的收敛 + 补一个"全集无 fallback"测试兜底。

### 开放问题
- 收敛改动面大但根治 vs 测试便宜但仍可能漏"新增的渲染点"。如何取舍？（收敛后新渲染点只需复用单一函数，漏的概率最低。）

## 硬约束 / 项目规范
- 不改行为/标签文案（除把已有 phase_lock 等补齐到位）；源文件 UTF-8。
- `apps/web/src/views/quant/**`、`components/quant/**` 受 `lint:quant-lines`（单文件 ≤500 行）约束；本任务主要在 `views/strategy`、`components/strategy`，注意行数。
- **.vue 改动合并前必跑 `pnpm --filter @cryptotrading/web build`（vite）**，`type-check`（vue-tsc）测不出 SFC 编译错。

## 验证标准
1. 新测试在故意删某枚举分支时变红；
2. `pnpm --filter @cryptotrading/web type-check` + `build` + `test` 全绿；
3. （若做收敛）真机点开 signal-stats 列表/结果/详情/导入下拉，phase_lock 等全显示正确中文标签。

## 前序进度 / 待续
反面案例已修（commit 2b97963 / 7913d91），但守门机制未加。本任务即补机制防回归。
