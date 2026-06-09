# 修复 signal-stats 运行态体验 — 设计 index

> 创建于 2026-06-09。源交接文档：`prompts/improve-signal-stats-run-status-ux.md`（实现完成后移入 `prompts/archive/`）。
> brainstorming 已与用户敲定全部开放问题（见下「决策摘要」）。所有 file:line 指**当前代码**（2026-06-09 已逐个落源头核对）。

## 背景与目标

`/signal-stats`（信号前向统计）运行态有两个让用户困惑的问题：

1. **进度条满了像卡死（UX 观感）**：进度条只反映「扫描交易日」一个阶段；扫完到 100% 后还有**不上报进度**的「模拟出场 + 写库」阶段（大样本下 ≥88 秒），用户看「100% + 扫描中 + 运行中」像卡死。
2. **刷新/切走丢轮询脱节（真 bug）**：运行态 + 进度只来自本会话 `startRun` 的内存轮询；刷新 / 切走切回 / 超 10 分钟 / 别处触发的 run，轮询就断；后端仍在跑、前端停在静态快照。还有「网络闪断一次就永久停轮询」的隐藏缺陷（`stores/signalStats.ts:80-87` catch 块一次异常即 `clearInterval`）。

**目标**：① 运行态如实展示三阶段真实进度（扫描→模拟→写库），不再假死；② 进页面/刷新/切回都恢复轮询并在 `completed` 后自动切指标，运行按钮按后端真值禁用（不撞 409）；③ 轮询/启动失败有提示、不静默。

## 决策摘要（brainstorming 已定）

| # | 决策点 | 选择 |
|---|---|---|
| 1 | 进度条满像卡死 | **完整**：后端上报三阶段真实进度（动 runner + simulator） |
| 2 | 脱节修复 + `runningId` | **方向 A**：弃 `runningId`，运行态/按钮全用后端 `latestRun.status` |
| 3 | 10min 硬超时 | **删除**，终止只看后端 `status` 到 `completed/failed` |
| 4 | 轮询模型 / 频率 | **单条 interval 轮询所有 running test**，频率 **2s** |
| 5 | 三阶段进度 UX | **n-steps 步骤条 + 当前步进度条**（`phase` 驱动高亮/文案） |
| 6 | 数据模型 | 加 1 列 `phase`，**复用** `progress_scanned/progress_total` 表「当前阶段 done/total」 |
| 7 | `lastPollError` | **补展示**（`n-alert` 轻量条，不静默吞错） |
| 8 | 恢复范围 | 进页面恢复**所有** `latestRun.status==='running'` 的 test（列表级） |

## 子文档清单与阅读顺序

1. [01-overview-and-data-flow.md](./01-overview-and-data-flow.md) — 现状摸底（已核对 file:line）、端到端数据流、phase 状态机
2. [02-backend.md](./02-backend.md) — 实体 + migration + simulator 回调 + runner 三阶段节流上报 + 后端单测
3. [03-frontend.md](./03-frontend.md) — api 类型 + store 单轮询器改造 + View/Table/Result + 新 RunProgress 子组件 + n-steps UX
4. [04-testing-and-tasks.md](./04-testing-and-tasks.md) — 验证标准（browser-driving 真机）、任务切分（SDD）、硬约束清单

建议按 `01 → 02 → 03 → 04` 顺序读。

## 跨文档引用约定

统一用相对路径 + 锚点，例：`./02-backend.md#4-runner三阶段节流上报`。所有「字段名 / 列名 / 行号」均以当前代码为准；进 migration / 实体 / 断言的事实已亲查真实文件。
