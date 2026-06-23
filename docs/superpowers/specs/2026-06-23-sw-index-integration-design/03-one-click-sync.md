# 03 · 并入一键同步（sw-index-daily step）

## 3.1 step 定位

- key：`'sw-index-daily'`
- 位置：紧跟 `'ths-index-daily'`（同属指数日线、逻辑相邻，在 `stock-amv` 前）。最终 STEP_ORDER（10 项，与大盘 spec `03 §3.1` 逐字一致）：
```text
base-data · a-shares · money-flow · ths-index-daily
  · sw-index-daily · market-index-daily · stock-amv · industry-amv · concept-amv · oamv
```
- syncMode：`'incremental'`（与所有 step 一致，one-click 全增量）
- 首次全量回填**不在此**：走 `GET /api/sw-index-daily/sync?syncMode=overwrite`（见 [02 §2.6](./02-backend-sync.md)）

> one-click-sync 所有 step 一律 `syncMode:'incremental'`（`step-runners.ts:326` 等），全量回填走各自同步页（注释口径 `step-runners.ts:411`）。

## 3.2 DB 约束判断（无需碰 CHECK / alembic）

A 股 one-click-sync 走 `one_click_sync_runs` 表，step 状态在 `steps jsonb` 列（`orchestrator.service.ts:178-189`）。**step key 集合无 DB CHECK 约束**，加 `'sw-index-daily'` 不触发任何 migration / alembic / `ml_jobs_run_type_check`（后者专属美股/quant/ml_jobs 线，与 A 股 one-click 无关）。

## 3.3 后端改动点（6 处，file:line 为证）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `one-click-sync/types.ts:10-18` | `OneClickStepKey` 加 `'sw-index-daily'` |
| 2 | `one-click-sync/types.ts:76-85` | `STEP_ORDER` 数组在 `'ths-index-daily'` 后插 `'sw-index-daily'`（索引即 `current_step`） |
| 3 | `one-click-sync/step-runners.ts:30-39` | `StepContext.services` 加 `swIndexDaily: SwIndexDailySyncService` |
| 4 | `one-click-sync/step-runners.ts`（新增） | `export async function runSwIndexDaily(ctx, index)`，参考 `runThsIndexDaily`(`:317-344`)：`awaitSubject(ctx.services.swIndexDaily.startSync({start_date,end_date,syncMode:'incremental'}), ...)` |
| 5 | `one-click-sync/one-click-sync-orchestrator.service.ts:49-58` | `STEP_RUNNERS` 数组插 `runSwIndexDaily`（顺序对齐 STEP_ORDER） |
| 6 | `one-click-sync/one-click-sync-orchestrator.service.ts:64-73` + `:191-200` | constructor 注入 `SwIndexDailySyncService` + `ctx.services` 组装加 `swIndexDaily: this.swIndexDaily` |

附带：`sw-index-daily.module.ts` 须 `exports: [SwIndexDailySyncService]`，`one-click-sync.module.ts` 的 `imports` 加 `SwIndexDailyModule`。

## 3.4 前端改动点（3 处）

| # | 文件 | 改动 |
|---|------|------|
| 7 | `apps/web/src/components/sync/oneClickSync.types.ts:5-13` | `OneClickStepKey` 加 `'sw-index-daily'`（与后端逐字镜像） |
| 8 | `oneClickSync.types.ts:78-87` | `STEP_LABELS` 加 `'sw-index-daily': '申万指数日线 (sw_daily)'` |
| 9 | `oneClickSync.types.ts:138-149` + `views/sync/SyncView.vue:13` | `buildInitialSteps()` 加一个 `emptyStep('sw-index-daily', ...)`；SyncView subtitle 文案补「申万指数」 |

## 3.5 共享文件域协调（重要）

`one-click-sync/` 是本 spec 与大盘 spec 的**共享冲突域**——两任务各加一个 step（`sw-index-daily` / `market-index-daily`），改动点 1/2/5/7/8/9 是同一批文件（types.ts / orchestrator / 前端 types）。

**SDD 并行策略**：one-click 并入**不拆成两个并行 agent**，而作为**一个串行任务**（两 spec 主任务完成后）由单个 agent 一次性加两个 step（sw + market），避免并行写 `types.ts`/`orchestrator.service.ts` 互相覆盖。详见 [05 §任务拆分](./05-validation-and-tasks.md)。
