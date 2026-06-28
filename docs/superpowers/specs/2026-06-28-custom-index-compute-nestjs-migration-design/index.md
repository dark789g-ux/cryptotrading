# 自定义指数计算 — Python worker 迁移至 NestJS

- 创建日期：2026-06-28
- 状态：设计已确认，**已实现**（2026-06-28）
- 前置 spec：[2026-06-28-custom-index-create-design](../2026-06-28-custom-index-create-design/index.md)（CRUD / 算法 / 前端）
- 交接来源：[prompts/archive/migrate-custom-index-compute-to-nestjs.md](../../../../prompts/archive/migrate-custom-index-compute-to-nestjs.md)

## 背景摘要

自定义指数（「我的指数」）W1–W5 已落地：NestJS 负责 CRUD + enqueue + SSE 壳，**历史合成计算仍在 Python quant worker**。用户必须另开终端 `uv run quant worker run`，否则指数永远停在 `pending`。

**本 spec 范围**：将 `custom_index_compute` 从 Python worker 迁入 NestJS 进程内 Runner，使用户 **仅 `pnpm dev`** 即可完成「创建 → 计算 → K 线可查」闭环。**算法口径不变**（对照 [03-index-computation.md](../2026-06-28-custom-index-create-design/03-index-computation.md) 与 Python 参考实现）。

## 已确认决策（brainstorming 2026-06-28）

| # | 决策 | 选择 |
|---|------|------|
| 1 | 计算执行体 | NestJS 进程内 `CustomIndexComputeRunner`（方案 A） |
| 2 | ml.jobs | **不再写入**；去掉 `latest_job_id` 更新 |
| 3 | 触发方式 | `scheduleCompute()` → `void runner.run(...).catch(...)`，HTTP 立即返回 |
| 4 | 进度推送 | SSE **1s 轮询** `custom_index_definitions`；移除 PgListen / `ml_job_progress` |
| 5 | SSE token | payload 仅 `{ custom_index_id, user_id }`，无 `job_id` |
| 6 | create/patch/recompute 响应 | **去掉** `job_id` 字段 |
| 7 | 重启恢复 | V1 startup hook：`status=computing` → `failed`，`last_error=interrupted` |
| 8 | 指标 / AMV | 复用 `indicators.ts` + `ths-index-daily-indicator` 模式；AMV 读 API 不变 |
| 9 | DB schema | **不改** `custom_index_*` 表 |
| 10 | 前端 | 尽量不改 Modal / 列表 / SSE UX |

## 非目标

- 不重做 5 步 Modal 或行情表 UX
- 不把其它 quant job（sync / train / factors）迁到 NestJS
- 不把 custom 指数写入 `index_daily_quotes`
- 不在同步 HTTP 中跑长计算

## 子文档清单

| 文档 | 说明 |
|------|------|
| [01-background-and-decisions.md](./01-background-and-decisions.md) | 现状、目标、方案对比、风险 |
| [02-runner-architecture.md](./02-runner-architecture.md) | Runner 目录、Stage 1–7、数据读写的、并发与分块 |
| [03-api-sse-migration.md](./03-api-sse-migration.md) | ComputeService / SSE / API 响应 / startup hook |
| [04-testing-rollout-and-cleanup.md](./04-testing-rollout-and-cleanup.md) | Jest、E2E、Python 清理、PR 切分、原 spec 同步 |

## 建议阅读顺序

1. `01` → 明确迁移 delta 与决策
2. `02` → Runner 实现核心（对照 Python + spec 03）
3. `03` → 接线与 SSE
4. `04` → 测试、清理、交付

## 跨文档引用约定

- 相对路径 + 锚点，例如 `./02-runner-architecture.md#stage-pipeline`
- 算法权威：[../2026-06-28-custom-index-create-design/03-index-computation.md](../2026-06-28-custom-index-create-design/03-index-computation.md)
- 字段名：DB / 写 body 用 snake_case；API 响应用 camelCase
- 业务日期：一律 `YYYYMMDD` 字符串

## 迁移后系统总览

```text
┌─ ASharesIndexCustomPanel ─────────────────────────────────────────┐
│  行情表（computing 时 SSE 推送 progress）                          │
└───────────────────────────────────────────────────────────────────┘
         │ POST create / PATCH / recompute
         ▼
  CustomIndexService ──▶ CustomIndexComputeService.scheduleCompute()
         │                      │
         │                      └── void CustomIndexComputeRunner.run()
         ▼
  custom_index_definitions  (status / compute_progress / compute_stage)
         ▲
         │ 1s poll
  GET /api/custom-indices/:id/stream  (SSE token: custom_index_id only)
         │
         ▼
  custom_index_daily_quotes / indicators / money_flow / amv
         │
         ▼
  GET kline / amv  →  ASharesIndexKlineModal (category=custom)
```

**删除路径**：`ml.jobs` INSERT → Python `compute_custom_index()` → NOTIFY
