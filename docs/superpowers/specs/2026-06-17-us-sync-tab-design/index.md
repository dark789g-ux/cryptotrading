# 数据同步页 Tab 化 + 美股一键同步（设计 index）

> 日期：2026-06-17 ｜ 状态：设计待实现 ｜ 形态：SDD（可拆分并行任务）

## 背景与目标

`apps/web/src/views/sync/SyncView.vue` 当前只有「一键同步 A 股核心数据」一张卡（`OneClickSyncPanel`），**无任何美股入口**。美股同步能力散落在 Symbols 浏览页（个股「同步」、指数「同步指数数据」按钮各派一条 `ml.jobs`），且指数 AMV 同步**前端无入口**（`POST /api/us-index-amv/sync` API 已封装但无 UI）。

本次目标：

1. **SyncView 改 Tab 结构**：外层 `n-tabs` 两个 Tab —「A股」「美股」。现有 A 股一键同步原样移入「A股」Tab。
2. **新增「美股」Tab：美股一键同步**，体验**镜像 A 股**（步骤列表 + 实时日志 + 结束 summary + 切页/刷新可恢复），一个按钮顺序跑三步：
   - 美股个股（`us_sync`，tracked 全集）→ 美股指数日线（`us_index_sync`，`.NDX`）→ 美股指数 AMV（`us_index_amv_sync`，`.NDX` 成分 + AMV）。
3. **根治盘中半根 + 指标 warmup**（2026-06-17 AMD 06-16 事故教训）：同步窗口 end 永不含未收盘当天；指标按全量历史 warmup 计算，只写用户所选窗口。

### 关键架构决策（已与用户敲定）

| 决策点 | 选择 | 理由 |
|---|---|---|
| 同步形态 | 完整一键同步（镜像 A 股 UX） | 与 A 股对称 |
| 编排器位置 | **Python 单 job**（新 run_type `us_one_click_sync`，一条 ml.jobs 在 worker 内跑三步） | 美股同步本就走 ml.jobs/worker；复用全部现成同步代码，不新建 NestJS 编排器/runs 表 |
| 同步窗口 | 用户选 `[start, end]` 日期（像 A 股，无默认） | 灵活；warmup/end-cap 内建不暴露给用户 |
| 步骤态存储 | `ml.jobs.result_payload`（jsonb 增量写） | 免 migration；`GET /api/quant/jobs/:id` 已返回 `resultPayload`，前端轮询可读 |
| 步骤范围 | 固定三步、固定顺序 | YAGNI |

## 子文档清单与阅读顺序

1. [01-architecture-and-dataflow.md](./01-architecture-and-dataflow.md) — Tab 结构、单 job 编排数据流、`result_payload` 步骤态 schema（前后端共享契约）、ASCII 总览。
2. [02-run-type-and-migrations.md](./02-run-type-and-migrations.md) — 新 run_type `us_one_click_sync` 的 4 处登记 + alembic/NestJS DB CHECK 迁移（含确切枚举值）。
3. [03-python-orchestrator.md](./03-python-orchestrator.md) — worker 侧 `us_one_click_sync` runner：三步顺序、`result_payload` 增量写 helper、失败不中断、取消语义。
4. [04-warmup-endcap-fetch.md](./04-warmup-endcap-fetch.md) — 三条抓取路径的「全量抓取 / 只写所选窗口 / 封顶在长 bar」正确性机制（`write_start` 参数契约 + end-cap helper）。
5. [05-nestjs-api.md](./05-nestjs-api.md) — 入队接口、恢复（按 run_type 列表查）、取消（复用）、`dateRange` 校验。
6. [06-frontend.md](./06-frontend.md) — SyncView Tab 化、`OneClickSyncPanel` 参数化复用、`usOneClickSync` store + `useUsOneClickSync` controller + `result_payload` 适配、类型/API client。
7. [07-testing-and-verification.md](./07-testing-and-verification.md) — 分层单测、真机 e2e、数据层验证清单。

## 跨文档引用约定

- 引用子文档用相对路径 + 锚点，例：[`result_payload` schema](./01-architecture-and-dataflow.md#result_payload-步骤态-schema前后端硬契约)。
- 引用代码用 `路径:行号`（设计期已核到真值的，标注「✅已核」）。

## 范围边界（不做）

- 不动 Symbols 页现有的美股零散同步按钮（个股「同步」、指数「同步指数数据」）—— 它们是浏览时就地快同步，与本页一键同步并存。
- 不做 ticker / 指数 symbol 选择 UI（一键 = tracked 全集 + `.NDX`）。
- 不修复前端 `JobRunType` 既有 drift 的全部缺失项（仅补本次新增的 `us_one_click_sync`，并在 06 文档标注既有 drift 供后续单独处理）。
