# 03 · 并入一键同步（market-index-daily step）

## 3.1 step 定位

- key：`'market-index-daily'`
- 位置：紧跟 `'sw-index-daily'`（申万 step 之后，同属指数日线，在 `stock-amv` 前）
- syncMode：`'incremental'`
- 首次全量**不在此**：走已存在的 `GET /api/ths-index-daily/sync/market`（读新范围，5 年分段，`MarketIndexSyncService.sync` `:72-177`）

STEP_ORDER 变 10 项：
```text
base-data · a-shares · money-flow · ths-index-daily
  · sw-index-daily · market-index-daily     ← 本任务加第 2 个
  · stock-amv · industry-amv · concept-amv · oamv
```

## 3.2 DB 约束判断（无需碰 CHECK / alembic）

同申万 [03 §3.2](../2026-06-23-sw-index-integration-design/03-one-click-sync.md)：A 股 one-click 走 `one_click_sync_runs`，steps 是 jsonb，step key 无 DB CHECK。

## 3.3 后端改动点（6 处，与申万同构）

| # | 文件 | 改动 |
|---|------|------|
| 1 | `one-click-sync/types.ts:10-18` | `OneClickStepKey` 加 `'market-index-daily'` |
| 2 | `one-click-sync/types.ts:76-85` | `STEP_ORDER` 在 `'sw-index-daily'` 后插 `'market-index-daily'` |
| 3 | `one-click-sync/step-runners.ts:30-39` | `StepContext.services` 加 `marketIndexSync: MarketIndexSyncService` |
| 4 | `one-click-sync/step-runners.ts`（新增） | `runMarketIndexDaily`，普通 await 风格（MarketIndexSyncService.sync 同步返回 result、不发 SSE，参考 `runOamv` `:429-447`）：`await ctx.services.marketIndexSync.sync({start_date,end_date})` |
| 5 | `one-click-sync/one-click-sync-orchestrator.service.ts:49-58` | `STEP_RUNNERS` 插 `runMarketIndexDaily` |
| 6 | `orchestrator.service.ts:64-73` + `:191-200` | constructor 注入 + `ctx.services` 组装 |

> `MarketIndexSyncService` 已在 `ths-index-daily.module.ts:9,27` 注册，`one-click-sync.module.ts` 的 `imports` 加 `ThsIndexDailyModule`（若未导入）即可获取。

## 3.4 前端改动点（3 处）

| # | 文件 | 改动 |
|---|------|------|
| 7 | `oneClickSync.types.ts:5-13` | `OneClickStepKey` 加 `'market-index-daily'` |
| 8 | `oneClickSync.types.ts:78-87` | `STEP_LABELS` 加 `'market-index-daily': '大盘指数日线 (index_daily)'` |
| 9 | `oneClickSync.types.ts:138-149` + `SyncView.vue:13` | `buildInitialSteps()` 加 `emptyStep('market-index-daily')`；SyncView subtitle 补「大盘指数」 |

## 3.5 共享文件域协调（重要）

与申万 [03 §3.5](../2026-06-23-sw-index-integration-design/03-one-click-sync.md) 同：`one-click-sync/` 是两 spec 共享冲突域。**SDD 不拆两个并行 agent**，作为**一个串行任务**由单 agent 一次加 `sw-index-daily` + `market-index-daily` 两 step，避免并行写 `types.ts`/`orchestrator.service.ts` 互相覆盖。见 [05 §任务拆分](./05-validation-and-tasks.md)。
