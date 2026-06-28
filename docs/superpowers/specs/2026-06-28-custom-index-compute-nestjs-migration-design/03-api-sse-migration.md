# API、SSE 与 ComputeService 改造

## CustomIndexComputeService

**文件**：`custom-index-compute.service.ts`

### 删除

- `jobsRepo` / `MlJobEntity` 依赖
- `ml.jobs` INSERT（`run_type=custom_index_compute`）
- 回写 `latest_job_id`

### 新增 / 改造

```text
scheduleCompute(opts: { customIndexId, userId, fullRebuild? })
  1. UPDATE definition SET status=pending, compute_progress=0, compute_stage=null
  2. void this.runner.run(opts).catch(err => log + mark failed)
```

- 对外可保留 `enqueue()` 作为 **别名** 指向 `scheduleCompute()`，减少 diff
- **删除** `cancelLatestJob()`（随 ml.jobs 移除）

### CustomIndexService 同步改动

**文件**：`custom-index.service.ts`

- `remove()`：`status === 'computing'` → **409 Conflict**（现后端未拦截，迁移时补齐；与前端 disabled 一致）
- `remove()` 不再调 `cancelLatestJob()`
- `issueSseToken()` / `getComputeSnapshot()`：见下文 SSE Token

### 调用方（不变）

`custom-index.service.ts` 的 `create` / `patch` / `recompute` 仍调 compute service。

## API 响应变更

### create / patch / recompute

**Before**：

```json
{ "id": "...", "ts_code": "CUST.xxxx.U", "job_id": "<uuid>", "status": "pending" }
```

**After**（create / patch / recompute 统一）：

```json
{ "id": "...", "ts_code": "CUST.xxxx.U", "status": "pending" }
```

- 去掉 `job_id`（brainstorming 已确认）
- 前端：`CreateCustomIndexResult` 删除 `job_id` 字段；业务代码未使用，SSE 走 `issueSseToken(indexId)`
- `patch` 若未触发重算，仍返回当前 `status`（可能为 `ready`），同样无 `job_id`

## SSE Token

### Before

- `issueSseToken` 要求 `latestJobId` 非空，否则 400「尚无计算任务」
- `SseTokenService.issueToken(jobId, userId)` → payload `{ job_id, user_id, exp }`
- `CustomIndexSseGuard` 读 `result.jobId` 写入 `req.sseTokenPayload.job_id`

### After

```text
POST /api/custom-indices/:id/sse-token
  → 不再检查 latestJobId（pending/computing 即可签发）
  → token payload: { custom_index_id, user_id, exp }
  → 不再查询 ml.jobs
```

### Token 实现路径（写死）

在 `SseTokenService` 新增 `issueCustomIndexToken(customIndexId, userId)`：

```text
sign payload { custom_index_id, user_id, exp }   // 不含 job_id
```

同步改造：

| 文件 | 改动 |
|------|------|
| `modules/quant/realtime/sse-token.util.ts` | 新增 `CustomIndexSseTokenPayload` 类型；`verifySseToken` 分支或独立 `verifyCustomIndexSseToken` |
| `custom-index.service.ts` `issueSseToken()` | 删 `latestJobId` 门槛；调 `issueCustomIndexToken`；响应去掉 `job_id` |
| `custom-index-sse.guard.ts` | 校验 custom index token → `req.sseTokenPayload = { custom_index_id, user_id }` |
| `custom-index-sse.controller.ts` | 读 `custom_index_id`（非 `job_id`）；校验 path `:id === token.custom_index_id` |

**不**复用 quant jobs 的 `job_id` payload，避免 guard 语义混淆。

## SSE Stream

**文件**：`custom-index-sse.controller.ts`

### Before

```text
subscribe PgListenService ml_job_progress (filter job_id)
  + findJob(jobId) 查 ml.jobs status
```

### After

```text
GET /api/custom-indices/:id/stream?token=...
  1. 建连后立即 push snapshot（getComputeSnapshot）
  2. setInterval 1000ms:
       snap = getComputeSnapshot(customIndexId, userId)
       push { status, progress, stage, last_error }
       if status in { ready, failed }: close stream
  3. 客户端 disconnect: clearInterval
```

**删除 / 清理**：

- `CustomIndexService.findJob()` 及对 `ml.jobs` 的查询
- `CustomIndexService.getPgListen()` 及 `QuantModule` 中仅为 custom SSE 引入的 `PgListenService` 依赖
- SSE controller 内 `PgListenService` 订阅
- token / snapshot 内的 `job_id` 字段（wire 不再返回）

### SSE Payload（保持前端兼容）

```typescript
interface CustomIndexSseProgressEvent {
  progress: number
  stage?: string | null
  status: CustomIndexStatus
  last_error?: string | null
}
```

`getComputeSnapshot()` 不再返回 `job_id`（现 wire 含该字段，迁移时移除）。

`useCustomIndexSse.ts` **无需改动**（已用 `issueSseToken(indexId)` + 上述字段）。

## Startup Hook

**触发**：`CustomIndexModule` 或 dedicated service `onModuleInit`

```sql
UPDATE custom_index_definitions
SET status = 'failed',
    last_error = 'interrupted',
    compute_stage = NULL
WHERE status = 'computing';
```

- 打 info log 含受影响行数
- 用户需手动点「重算」恢复

## 架构对比图

```text
┌─────────────── Before ───────────────┐
│ POST create                          │
│   → INSERT ml.jobs                   │
│   → latest_job_id = job.id           │
│ SSE token { job_id }                 │
│ SSE ← NOTIFY ml_job_progress         │
│ Python worker → custom_index_*       │
└──────────────────────────────────────┘

┌─────────────── After ────────────────┐
│ POST create                          │
│   → scheduleCompute()                │
│   → void runner.run()                │
│ SSE token { custom_index_id }        │
│ SSE ← poll definitions 1s            │
│ NestJS runner → custom_index_*       │
└──────────────────────────────────────┘
```

## ml.jobs 遗留处理

| 项 | 处理 |
|----|------|
| DB `ml_jobs_run_type_check` 含 `custom_index_compute` | **不回滚**；历史 job 无害 |
| `latest_job_id` 列 | 保留；新代码不再写入 |
| `MlJobEntity` 联合类型 | 可保留或注释 deprecated |
| 前端 quant jobs 页 | 不受影响 |

## 原 spec 同步项

迁移完成后更新 [04-api-and-jobs.md](../2026-06-28-custom-index-create-design/04-api-and-jobs.md)：

- 删除 ml.jobs / Python worker 章节
- 改为 NestJS Runner + SSE 轮询
- 更新 create 响应（无 `job_id`）
- 更新 [index.md](../2026-06-28-custom-index-create-design/index.md) 系统总览图 worker 箭头

更新 [CLAUDE.md](../../../../CLAUDE.md)：**自定义指数不再要求 quant worker**。
