# 组合模拟「直接设置信号源」设计 — 总入口

> 让「组合模拟 portfolio-sim」的新建界面**能直接设置/定义信号源**,不再逼用户先去
> 「信号前向统计 signal-stats」跑出 run、再把 `runId` 复制粘贴回来。
> 交接来源:[prompts/add-direct-signal-source-setup-to-portfolio-sim.md](../../../../prompts/add-direct-signal-source-setup-to-portfolio-sim.md)
> 日期:2026-06-14 · 工作目录 `C:\codes\cryptotrading`(Windows + PowerShell)

## 背景与目标(摘要)

现状:组合模拟新建弹窗的源行**已有信号源选择器**——但只能选「某方案的**最新** completed run」,
想用历史 run 要切高级模式手填 uuid;想测**全新入场条件**则必须离开页面去 signal-stats
建方案+跑 run+回填 runId。

本设计补两个缺口(经 brainstorming 与用户敲定为**两者都做 = 路径 C**):

- **路径 A — 选历史 run**:方案选中后加二级下拉,列该方案全部 run(仅 completed 可选,默认最新)。
- **路径 B — 内联定义新信号源**:源行内开子弹窗,整体复用 `SignalTestForm` 定义条件,
  提交即 `create + triggerRun`(**非阻塞**),`runId` 回填源行并轮询进度。

**不变量**:源最终仍只提交 `runId`(uuid),loader/engine/anchorMode 代数恒等等既有契约 **100% 不动**;
后端**零改动**;无 shared-types 改动。

## 已敲定的关键决策(brainstorming 产出)

| # | 决策点 | 结论 |
|---|--------|------|
| D1 | 核心范围 | **C = A + B 并存**;高级手填 uuid 老路**保留**(回归) |
| D2 | B 异步等待 UX | **非阻塞草稿 + 进度可见**;复用现有「建方案→单独 triggerRun」两段式 + `validateSourceRuns` 闸门,不造阻塞状态机 |
| D3 | B 复用边界 | **整体内嵌 `SignalTestForm`**(不抽精简版:出场模式决定逐笔 ret 不能省;组件已自包含低耦合) |
| D4 | B 表单放置 | **子弹窗**(不把 491 行表单平铺进新建弹窗) |
| D5 | 进度/列表 key | **testId**(已落源头核实:`getRunProgress`/`listRuns` 路由参数都是 testId,非 runId) |
| D6 | run 失败态枚举 | **`'failed'`**(非 `'error'`;已核实:`signal-test-run.entity.ts:20` / `signal-stats.runner.ts:104` / `signalStats.ts:69` 三处一致);完整枚举 `'running' \| 'completed' \| 'failed'` |

## 子文档清单(建议阅读顺序)

1. [01-ux-and-flows.md](./01-ux-and-flows.md) — 三种来源方式、A 二级 run 选择、B 内联流程、ASCII 线框/流程图、只读条件摘要。
2. [02-frontend-components-and-types.md](./02-frontend-components-and-types.md) — 组件拆分(500 行约束)、新文件清单与职责、composable、类型镜像。
3. [03-backend-contracts-invariants.md](./03-backend-contracts-invariants.md) — 后端零改动证据、已核实 API 路由/参数、数据流、契约与不变量。
4. [04-errors-and-edge-cases.md](./04-errors-and-edge-cases.md) — 错误处理表、边界、轮询生命周期、回归项、待确认假设。
5. [05-testing-gates-and-e2e.md](./05-testing-gates-and-e2e.md) — 门禁命令、真机 e2e 剧本、落源头核查清单。

## 跨文档引用约定

统一用相对路径 + 锚点(锚点须用渲染器生成的完整 slug,含中文/括号);例:`[02 文档](./02-frontend-components-and-types.md)`。
代码位置用 `file:line`(相对仓库根),例:`apps/web/src/components/portfolio-sim/PortfolioSimSourceRow.vue:252`。

## 相关资料

- [doc/使用指南/组合模拟使用指南.md](../../../../doc/使用指南/组合模拟使用指南.md)
- 记忆:`project_portfolio_simulator`、`project_portfolio_sim_engine_upgrade`、`project_signal_forward_stats`
- 规范:[.claude/rules/vue3-frontend.md](../../../../.claude/rules/vue3-frontend.md)、[.claude/rules/data-integrity.md](../../../../.claude/rules/data-integrity.md)
