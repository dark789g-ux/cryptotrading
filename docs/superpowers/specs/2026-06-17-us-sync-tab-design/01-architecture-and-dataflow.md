# 01 架构与数据流

[← index](./index.md)

## Tab 结构（SyncView.vue）

```text
┌─ 数据同步 ─────────────────────────────────────────┐
│  ┌──────┬──────┐   n-tabs（外层）                   │
│  │ A股  │ 美股 │                                     │
│  └──────┴──────┘                                     │
│  ┌────────────────────────────────────────────────┐ │
│  │ [A股]  <OneClickSyncPanel :controller=aCtrl     │ │
│  │           title="一键同步 A 股核心数据" ... />  │ │
│  │ [美股] <OneClickSyncPanel :controller=usCtrl    │ │
│  │           title="一键同步美股数据" ... />       │ │
│  └────────────────────────────────────────────────┘ │
└──────────────────────────────────────────────────────┘
```

- 同一展示组件 `OneClickSyncPanel.vue` 被两个 Tab 复用，仅 `controller` 与 `title/subtitle` 不同（参数化见 [06](./06-frontend.md#oneclicksyncpanel-参数化)）。
- A 股 controller = 现有 `useOneClickSync`（读 `oneClickSync` store，轮询后端 `one_click_sync_runs`）。
- 美股 controller = 新 `useUsOneClickSync`（读 `usOneClickSync` store，轮询 `ml.jobs` 行的 `result_payload`）。
- 两个 controller 实现**同一接口** `OneClickPanelController`（见 [06](./06-frontend.md#面板-controller-接口)），面板与具体 controller 解耦。

## 单 job 编排数据流（端到端）

```text
前端「美股」Tab                         NestJS                     Python worker
──────────────                         ──────                     ─────────────
点「开始同步」                                                       (poller 轮询 ml.jobs)
 │ dateRange[start,end]                                            
 ├─POST /api/us-stocks/one-click-sync ─▶ 校验+入队 1 条 ml.jobs ──▶ 领取 us_one_click_sync job
 │                                       (run_type=us_one_click_sync)        │
 │◀──────────── {jobId} ───────────────                                     ▼
 │                                                              step1 run_us_sync(write_start)
 ├─轮询 GET /api/quant/jobs/:id (2s) ◀── 返回完整实体          │  ├ 增量写 result_payload
 │   读 result_payload.steps/logs       (含 resultPayload)     │  └ update_progress(0..33)
 │   → 渲染步骤表/日志/summary                                 step2 run_us_index_sync(write_start)
 │  （SSE 仅作总进度条加速，可选）                              │  └ update_progress(33..66)
 │                                                              step3 run_us_index_amv_sync(write_start)
 ├─切走/刷新：GET /api/quant/jobs                              │  └ update_progress(66..100)
 │   ?run_type=us_one_click_sync&page_size=1 ──▶ 取最近一条     ▼
 │   running 则恢复轮询                                        dispatcher 终态 success/failed/cancelled
 │                                                              (result_payload 已含最终 steps/summary)
 └─取消：POST /api/quant/jobs/:id/cancel ─▶ 置 cancel_requested ─▶ 步间 check_cancel_requested → JobCancelled
```

### 为什么步骤态走「轮询 result_payload」而非 SSE

`update_progress` 的 NOTIFY payload **硬上限 1KB、禁带数组/日志正文**（`apps/quant-pipeline/.../worker/progress.py:72-101` ✅已核），SSE 事件只携带 `{job_id, progress, stage, status}`（`quant-jobs-sse.controller.ts` ✅已核）。因此**逐步骤的 status/rowsWritten/errors/日志只能写进 `result_payload`，前端轮询 `GET /api/quant/jobs/:id` 读取**（该接口返回完整实体含 `resultPayload`，`quant-jobs.service.ts:171-177` ✅已核）。SSE 可作为总进度条的实时加速（非必需）。

## result_payload 步骤态 schema（前后端硬契约）

Python runner 增量写、前端 adapter 读，**字段名/形态对齐 A 股 `OneClickStepState`/`OneClickSummary`/`LogEntry`**（`apps/web/src/components/sync/oneClickSync.types.ts` ✅已核存在这些类型），以便前端适配后直接喂给 `OneClickSyncPanel`。

```jsonc
// ml.jobs.result_payload （随 job 推进增量覆盖整对象）
{
  "version": 1,
  "range": { "start": "20260101", "end": "20260616", "cappedEnd": "20260616" },
  "startedAt": 1718600000000,          // epoch ms（worker 写入时刻）
  "finishedAt": null,                   // 终态时填
  "cancelled": false,
  "steps": [
    {
      "step": "us-stocks",              // 固定 key，见下表
      "status": "success",              // pending|running|success|failed|skipped
      "percent": 100,                   // 0..100（步内）
      "rowsWritten": 36806,             // 该步累计写入行（quote_rows 等）
      "phase": "us_sync:NVDA",          // 可空，当前子阶段
      "message": "62 只完成",           // 可空，一句话
      "errors": [                        // OneClickErrorItem[]，failed_items/errors 透出
        { "step": "us-stocks", "level": "warn", "apiName": "us_daily_empty", "message": "..." }
      ],
      "startedAt": 1718600000000,
      "finishedAt": 1718600060000
    }
    // ... us-index-daily / us-index-amv
  ],
  "logs": [                              // LogEntry[]，前端「实时日志」
    { "ts": 1718600000000, "step": "us-stocks", "level": "info", "text": "开始美股个股同步" }
  ]
}
```

### 步骤 key / label（前端 STEP_LABELS）

| step key | label（前端） | 后端动作 | run_type 复用 |
|---|---|---|---|
| `us-stocks` | 美股个股 | `run_us_sync` tracked 全集 | `us_sync` 逻辑 |
| `us-index-daily` | 美股指数日线 | `run_us_index_sync` `.NDX` | `us_index_sync` 逻辑 |
| `us-index-amv` | 美股指数 AMV | `run_us_index_amv_sync` `.NDX` | `us_index_amv_sync` 逻辑 |

> 注：`logs` 数组随步骤增长，须设上限（**后端 result_payload 防膨胀上限 ≤ 200 条**，超出丢弃最旧）。这与 A 股前端显示用的 `LOG_LIMIT=500`（`oneClickSync.types.ts:53` ✅已核）**是两个不同关注点**（一个防 jsonb 膨胀、一个前端渲染量），数字不同不矛盾，勿强行统一。end-cap/warmup 不进 schema（属抓取内部，见 [04](./04-warmup-endcap-fetch.md)）。

## 组件清单（新增 / 改动）

```text
后端 Python
  + sync/us_one_click_orchestrator.py     新：三步编排 + result_payload 增量写
  ~ worker/dispatcher.py                   改：_ROUTES 加 'us_one_click_sync'；加 _update_job_result_partial
  ~ sync/us_daily.py                       改：sync_us_daily_for_ticker 加 write_start
  ~ sync/us_index.py                       改：sync_us_index_for_symbol 加 write_start
  ~ sync/us_index_amv.py                   改：AMV 写入加 write_start 窗口限制
  ~ sync/us_orchestrator.py / us_index_orchestrator.py / us_index_amv_orchestrator.py  改：透传 write_start + end-cap
  + sync/us_market_calendar.py（或内联）   新：end-cap helper（丢在长 bar / 算 capped_end）
  + db/migrations/versions/<rev>_add_us_one_click_sync_run_type.py   新 alembic

后端 NestJS
  ~ entities/ml/ml-job.entity.ts           改：MlJobRunType 加 'us_one_click_sync'
  ~ modules/quant/dto/create-job.dto.ts    改：ALLOWED_RUN_TYPES 加 'us_one_click_sync'
  ~ market-data/us-stocks/us-stocks.controller.ts / .service.ts / .types.ts  改：加 one-click-sync 入队接口
  + migrations/<ts>-us-one-click-sync-run-type-check.sql (+ .ps1)   新 DB CHECK 镜像

前端
  ~ views/sync/SyncView.vue                改：n-tabs A股/美股
  ~ components/sync/OneClickSyncPanel.vue  改：加 title/subtitle props
  + components/sync/oneClickSync.types.ts  改：抽 OneClickPanelController 接口 + 美股 step key/labels（或新文件）
  + components/sync/useUsOneClickSync.ts   新：美股 controller
  + stores/usOneClickSync.ts               新：美股 store（轮询 result_payload）
  ~ api/modules/market/usStocks.ts         改：加 startOneClickSync + JobRow.resultPayload 类型
  ~ api/modules/quant.ts                    改：JobRunType 加 'us_one_click_sync'
```
