# 背景与决策

## 现状

| 层 | 状态 |
|----|------|
| NestJS CRUD | 已实现：`POST/PATCH/DELETE`、`preview-weights`、`GET latest/kline/amv` |
| NestJS 计算 | **未实现**：`custom-index/compute/` 目录不存在 |
| 触发 | `CustomIndexComputeService.enqueue()` INSERT `ml.jobs`（`run_type=custom_index_compute`） |
| 执行 | Python worker → `quant_pipeline/custom_index/compute.py` |
| SSE | token 绑 `job_id`；订阅 `PgListenService` / `ml_job_progress` |
| 前端 | Modal + Panel + `useCustomIndexSse`（`issueSseToken(indexId)`，不依赖 create 返回的 `job_id`） |

**用户痛点**：只跑 `pnpm dev` 时指数永远 `pending`，必须另开 quant worker 终端。

## 目标

1. 仅 `pnpm dev` 闭环：创建 → `computing` → progress 递增 → `ready` → K 线 + 0AMV 副图可查
2. 算法口径与 [03-index-computation.md](../2026-06-28-custom-index-create-design/03-index-computation.md) 及 Python 实现对齐
3. 前端尽量零改；允许后端 SSE token 语义微调、TypeScript 类型去掉 `job_id`

## 方案对比

### 方案 A — NestJS 进程内 Runner + SSE 轮询（**采用**）

```text
scheduleCompute() ──▶ void runner.run()
SSE ──1s poll──▶ custom_index_definitions
```

| 优点 | 缺点 |
|------|------|
| 只需 `pnpm dev` | 长历史占 Node 事件循环（分块 yield 缓解） |
| 与 `one-click-sync-orchestrator` 模式一致 | 重启需 startup hook 处理悬挂 `computing` |
| 前端几乎零改 | |

### 方案 B — 保留 ml.jobs 审计 + NestJS 计算（未采用）

仍 INSERT job，progress 写 definitions，SSE 仍可能绑 job。

| 优点 | 缺点 |
|------|------|
| 保留 job 历史 | 与「去掉 ml.jobs」决策冲突；双状态源 |

### 方案 C — NestJS spawn Python 子进程（未采用）

| 优点 | 缺点 |
|------|------|
| 算法零 port | 仍依赖 quant-pipeline 环境；违背目标 |

## 与原版 spec 的关系

| 维度 | 原 spec | 本迁移 spec |
|------|---------|---------------|
| 算法 `03` | 不变 | 执行位置 Python → NestJS |
| DB `02` | 不变 | 不改 schema；`latest_job_id` 列保留但不写 |
| API `04` | ml.jobs + worker | **迁移完成后需更新** `04-api-and-jobs.md` |
| 前端 `05` | 不变 | 类型去掉 `job_id` |
| 测试 `07` | W2=Python worker | Jest port + 删 Python 测试 |

## Python 参考源（port 对照）

```text
apps/quant-pipeline/src/quant_pipeline/custom_index/
├─ compute.py           → custom-index-compute.runner.ts
├─ weight_resolver.py   → custom-index-weight-resolver.ts
├─ price_index.py       → custom-index-price-index.ts
├─ total_return.py      → custom-index-total-return.ts
├─ indicators.py        → custom-index-indicator.service.ts
├─ money_flow.py        → custom-index-money-flow.service.ts
└─ amv.py               → custom-index-amv-writer.ts
```

**事实修正**（相对 handoff / 原 spec）：

- Python 单测实际 **2 个**（`test_weight_resolver.py`、`test_price_index.py`），非 6 个
- `test_chain_link.py` 在原 spec `07` 中列出但 **未实现**，需在 Jest 新增

## 风险与缓解

| 风险 | 缓解 |
|------|------|
| 大 basket + 长历史阻塞事件循环 | 按 trade_date **250 日/块**分块；块间 `await setImmediate()` 或 `setTimeout(0)` |
| 进程重启 `computing` 悬挂 | **V1 startup hook** → `failed` + `last_error=interrupted` |
| 与 Python 数值漂移 | port fixture；2 成分 10 日 snapshot 对比（可选脚本） |
| SSE 轮询开销 | computing 行通常仅一条；1s 间隔足够 |

## 易错对照（Python → TypeScript）

1. `base_point` 落在 **`actual_start_date`**，非用户填的 `base_date`
2. **停牌日**：可交易成分权重再归一化
3. **全收益 fallback**：缺分红数据 → 该日按价格指数口径，写 warning，**不改** `index_type`
4. **资金流**：等权 SUM，**不用** `members.weight` 加权
5. **日期**：全程 `YYYYMMDD`，禁止 `new Date()` 解析业务日
6. **`full_rebuild`**：DELETE 该指数 quotes/indicators/money_flow/amv 后全量重算

## 可复用 NestJS 代码

| 能力 | 参考 |
|------|------|
| 指数指标 MA/MACD/KDJ/BBI/砖图 | `ths-index-daily-indicator.service.ts` + `indicators/indicators.ts` |
| AMV 公式 | `active-mv/amv-formula.ts`（`calcAmvSeries` / `calcMacd`） |
| 宽基资金流（思路，非 SQL 照搬） | `money-flow-aggregation.service.ts` — custom 用 **等权 SUM** |
| 批量 UPSERT | `market-data/_shared/sync-helpers.ts` → `batchUpsert` |
| fire-and-forget | `one-click-sync-orchestrator.service.ts` |
