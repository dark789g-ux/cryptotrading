# 05 NestJS API

[← index](./index.md)

复用现有量化 jobs 基建，只新增**一个入队接口**；恢复/取消/查询全部复用现成接口。

## 新增：入队一键同步

挂在 us-stocks 模块（与现有 `POST /api/us-stocks/sync` 同模块，us-stocks.controller.ts:63-67 ✅已核）：

```
POST /api/us-stocks/one-click-sync     @AdminOnly()
body: { dateRange: [string, string] }   // [YYYYMMDD, YYYYMMDD]，必填
→ { jobId: string }
```

### Controller / Service

- Controller 方法仿现有 `sync()`（controller.ts:63-67 ✅已核），`@AdminOnly()`，调 `service.oneClickSync(body, user.id)`。
- Service `oneClickSync(body, createdBy)`（仿 `sync()`，us-stocks.service.ts:230-265 ✅已核）：
  - 校验 `dateRange`：必填、二元组、两段均 `YYYYMMDD`（复用现有 `YYYYMMDD_RE`）、`start <= end`，否则 `BadRequestException`（与 sync() 同款，service.ts:233-245 ✅已核）。
  - 注意：**dateRange 必填**（不像 `sync()` 可选）——一键同步无「缺省全量」语义，必须带窗口。
  - `params.date_range = "${start}:${end}"`（冒号串，Python 读，service.ts:247 ✅已核同款）。**不传 tickers/symbols**（编排器内部固定 tracked 全集 + `.NDX`）。
  - `QuantJobsService.create({ runType: 'us_one_click_sync', params, priority: 100, maxAttempts: 1 }, createdBy)` → `{ jobId }`。

### 请求/响应类型

`us-stocks.types.ts` 加（仿 `UsStockSyncBody` L142-148 ✅已核）：

```typescript
export interface UsOneClickSyncBody { dateRange: [string, string]; }   // 必填
// 响应复用 { jobId: string }
```

## 复用：恢复（切页/刷新）

无需新接口。前端进「美股」Tab 时查最近一条该 run_type 的 job（quant-jobs 列表接口 ✅已核支持 `run_type` 过滤、`created_at DESC`）：

```
GET /api/quant/jobs?run_type=us_one_click_sync&page_size=1
→ items[0] 即最近一条；status==='running' 则恢复轮询
```

## 复用：进度轮询（步骤态来源）

```
GET /api/quant/jobs/:id          ✅已核返回完整实体含 resultPayload
→ { status, progress, stage, resultPayload, ... }
前端读 resultPayload.steps/logs 渲染步骤表/日志/summary
```

> ⚠️ 前端 `JobRow` 类型当前**缺 `resultPayload`**（quant.ts:179-206 ✅已核）。在 06 文档要求补 `resultPayload?: Record<string, unknown>`（NestJS 直接返回 entity，默认序列化 camelCase → `resultPayload`）。

## 复用：取消

```
POST /api/quant/jobs/:id/cancel   ✅已核：running/pending → 置 cancel_requested
```

worker 步间 `check_cancel_requested` 读到后抛 `JobCancelled`（见 [03](./03-python-orchestrator.md#失败不中断--取消)）。

## 复用：SSE（可选加速）

总进度条可选接 SSE（token: `POST /api/quant/jobs/:id/sse-token` → stream: `GET /api/quant/jobs/:id/stream?token=` ✅已核）。**步骤表/日志不依赖 SSE**（SSE payload 仅 progress/stage/status）。最简实现：**只轮询、不接 SSE**（2s 轮询足够，A 股一键同步亦是纯轮询，oneClickSync store ✅已核）。推荐先纯轮询，SSE 留 P2。

## 接口汇总

```text
新增  POST /api/us-stocks/one-click-sync   入队（dateRange 必填）→ {jobId}
复用  GET  /api/quant/jobs?run_type=us_one_click_sync&page_size=1   恢复
复用  GET  /api/quant/jobs/:id             轮询 result_payload
复用  POST /api/quant/jobs/:id/cancel       取消
（可选）SSE token + stream                  总进度条加速
```
