# 交接：自定义指数计算从 Python worker 迁移到 NestJS

## 背景与目标

**用户决策（2026-06-28）**：自定义指数（「我的指数」）的历史合成计算应在 **NestJS 后端**完成，**不再依赖** `quant-pipeline` Python worker。

**现状**：创建/编辑指数后，`CustomIndexComputeService` 向 `ml.jobs` 插入 `run_type=custom_index_compute`；Python worker 消费 job，写入 `custom_index_daily_*` 表。用户必须另开终端跑 `uv run quant worker run`，否则指数永远停在 `pending`。

**目标**：

1. 仅启动 `pnpm dev`（NestJS + Web + DB）即可完成「创建指数 → 计算 → K 线可查」闭环。
2. **算法口径不变**（与 spec 及现有 Python 实现对齐）：链式链接 Laspeyres、权重版本链 PIT、价格指数/全收益、等权 SUM 资金流、AMV + MACD 副图。
3. 前端 **尽量不改**（Modal / 列表 / SSE UX 保持）；允许后端 SSE token 语义微调。

**非目标**：

- 不改 DB schema（`custom_index_*` 表已 migration 就绪）。
- 不重做前端 5 步 Modal。
- 不把其它 quant job（sync / train / factors）迁到 NestJS。

---

## 权威文档

| 文档 | 用途 |
|------|------|
| [docs/superpowers/specs/2026-06-28-custom-index-create-design/index.md](../docs/superpowers/specs/2026-06-28-custom-index-create-design/index.md) | 总览 |
| [02-data-model.md](../docs/superpowers/specs/2026-06-28-custom-index-create-design/02-data-model.md) | 表结构、状态机 |
| [03-index-computation.md](../docs/superpowers/specs/2026-06-28-custom-index-create-design/03-index-computation.md) | **算法**（迁移时逐条对照） |
| [04-api-and-jobs.md](../docs/superpowers/specs/2026-06-28-custom-index-create-design/04-api-and-jobs.md) | API（需更新 jobs 章节） |
| [06-derived-metrics.md](../docs/superpowers/specs/2026-06-28-custom-index-create-design/06-derived-metrics.md) | 指标/资金流/AMV |

---

## 当前代码地图

### NestJS（保留并扩展）

```text
apps/server/src/market-data/custom-index/
├─ custom-index.module.ts
├─ custom-index.controller.ts
├─ custom-index.service.ts              # CRUD + kline/amv 查询
├─ custom-index-compute.service.ts      # ★ 改：enqueue ml.jobs → 触发 NestJS 计算
├─ custom-index-sse.controller.ts       # ★ 改：进度来源不再绑 ml.jobs NOTIFY
├─ custom-index-sse.guard.ts
├─ dto/
└─ custom-index.service.spec.ts

apps/server/src/entities/custom-index/   # 7 张表 entity，不动
```

### Python（迁移后删除或停用）

```text
apps/quant-pipeline/src/quant_pipeline/custom_index/   # 9 个文件，算法参考源
apps/quant-pipeline/src/quant_pipeline/worker/dispatcher.py  # 移除 custom_index_compute 路由
apps/quant-pipeline/tests/custom_index/                  # 6 个测试 →  port 到 Jest
```

### 前端（基本不动）

```text
apps/web/src/components/symbols/a-shares-index/
├─ CreateCustomIndexModal.vue + create-custom-index/*
├─ ASharesIndexCustomPanel.vue
└─ useCustomIndexSse.ts                 # 订阅 SSE；payload 仍为 status/progress/stage

apps/web/src/api/modules/market/customIndex.ts
```

---

## 推荐架构（NestJS 内计算）

```text
POST /api/custom-indices
        │
        ▼
CustomIndexService.create()  ──事务──▶ insert definition + version + members
        │
        ▼
CustomIndexComputeService.scheduleCompute()
        │  （不 await 长计算；POST 立即返回 pending）
        ▼
setImmediate / void Promise
        │
        ▼
CustomIndexComputeRunner.run({ customIndexId, userId, fullRebuild })
        │
        ├─ Stage 1 load_members      → UPDATE status=computing, progress=5
        ├─ Stage 2 sync_quotes       → 批量读 raw.daily_quote / adj_factor
        ├─ Stage 3 compute_quotes    → UPSERT custom_index_daily_quotes
        ├─ Stage 4 indicators        → 复用 indicators/calcIndicators + brick
        ├─ Stage 5 money_flow        → SQL 聚合 money_flow_stocks（PIT）
        ├─ Stage 6 amv               → 复用 active-mv/amv-formula.ts
        └─ Stage 7 finalize          → status=ready, progress=100
```

### 关键设计决策（实现前确认，默认按下列执行）

| # | 决策 | 推荐 |
|---|------|------|
| 1 | 是否保留 `ml.jobs` 记录 | **否**。去掉 `latest_job_id` 写入；`issueSseToken` 改为仅绑 `custom_index_id`（见下文 SSE） |
| 2 | 计算触发方式 | `scheduleCompute()` 内 `void runner.run(...).catch(...)`，**禁止**阻塞 HTTP |
| 3 | 并发控制 | 内存 Map + DB `status=computing` 双重检查；computing 时 PATCH/recompute → 409（已有） |
| 4 | 进度推送 | SSE **轮询** `custom_index_definitions`（1s interval），**移除**对 `PgListenService` / `ml_job_progress` 的依赖 |
| 5 | 指标计算 | **复用** `apps/server/src/indicators/indicators.ts` + `brick-chart.ts`（照抄 `ThsIndexDailyIndicatorService` 模式，读写的表改为 `custom_index_daily_*`） |
| 6 | AMV API | 保持现有 `getAmv()`（已从 DB amv 列 + `calcMacd` 出 `AmvSeriesRow`） |
| 7 | Event loop | 长区间按 trade_date **分块**（如 250 日/块），块间 `await setImmediate` 或 `setTimeout(0)`，避免阻塞 NestJS |

---

## 实现任务清单

### Phase 1 — 计算 Runner（核心）

在 `apps/server/src/market-data/custom-index/compute/` 新建：

| 文件 | 职责 | Python 对照 |
|------|------|-------------|
| `custom-index-weight-resolver.ts` | PIT 版本链解析 | `weight_resolver.py` |
| `custom-index-price-index.ts` | 价格指数链式链接 | `price_index.py` |
| `custom-index-total-return.ts` | 全收益 + fallback warning | `total_return.py` |
| `custom-index-quotes-writer.ts` | 批量 UPSERT quotes | `compute.py` Stage 3 |
| `custom-index-indicator.service.ts` | MA/MACD/KDJ/BBI/砖图 | `indicators.py`；参考 `ths-index-daily-indicator.service.ts` |
| `custom-index-money-flow.service.ts` | 等权 SUM | `money_flow.py`；参考 `money-flow-aggregation.service.ts` `aggregateIndex` |
| `custom-index-amv-writer.ts` | AMV 序列落库 | `amv.py`；用 `calcAmvSeries` / 简化公式 |
| `custom-index-compute.runner.ts` | 编排 Stage 1–7、更新 progress/stage | `compute.py` |

**数据读取**（PostgreSQL，只读）：

- 成分 OHLCV：`raw.daily_quote`（或项目内 a-share 查询层已有的 qfq 字段）
- 复权：`raw.adj_factor`
- 流通市值：`raw.daily_basic.float_mv`（preview-weights 已在 NestJS 实现，可复用查询）
- 资金流：`money_flow_stocks`
- 交易日历：`raw.trade_cal`（校验 base_date / effective_date）

**进度字段**（写 `custom_index_definitions`）：

```text
compute_progress: 5 → 15 → 50 → 60 → 70 → 80 → 100
compute_stage:    load_members | sync_quotes | quotes | indicators | money_flow | amv | finalize
status:           pending → computing → ready | failed
last_error:       失败时写入
```

### Phase 2 — 改造 ComputeService

**文件**：`custom-index-compute.service.ts`

- 删除 `jobsRepo` 依赖与 `ml.jobs` INSERT。
- `enqueue()` 重命名为 `scheduleCompute()`：
  - UPDATE definition `status=pending`, `compute_progress=0`
  - `void this.runner.run(...)`
- `cancelLatestJob()`：改为内存 AbortSignal / `computing` 标志（V1 可简化为「computing 时不允许 delete」已够用）。

**调用方**：`custom-index.service.ts` 的 create / patch / recompute 仍调 compute service，接口名可保留 `enqueue` 别名以免大范围 diff。

### Phase 3 — SSE 解耦 ml.jobs

**文件**：`custom-index-sse.controller.ts`、`custom-index.service.ts`

当前问题：

- `issueSseToken` 要求 `latestJobId` 非空。
- SSE 订阅 `PgListenService` 的 `ml_job_progress`，绑 `job_id`。

改造：

1. `issueSseToken(customIndexId)`：token payload 仅含 `{ custom_index_id, user_id }`（改 `SseTokenService` 用法或 custom-index 专用 token）。
2. `GET /api/custom-indices/:id/stream`：建连后发 snapshot；之后 **每 1s** `getComputeSnapshot()` 直到 `status ∈ {ready, failed}`。
3. 删除 `findJob()`、SSE 内对 `ml.jobs` 的查询。
4. 前端 `useCustomIndexSse.ts`：**若** payload 仍含 `status/progress/stage`，可零改；若 token API 响应字段变了，同步改 `customIndex.ts`。

### Phase 4 — 清理 Python

- 删除 `apps/quant-pipeline/src/quant_pipeline/custom_index/`（或整目录标记 deprecated 一个 PR 后再删）。
- `dispatcher.py` 移除 `custom_index_compute` 路由。
- 删除 `apps/quant-pipeline/tests/custom_index/`（逻辑已在 Jest 覆盖后）。

**可选**：DB `ml_jobs_run_type_check` **不必**回滚 `custom_index_compute`（历史 job 无害）；新代码不再插入即可。

**Entity**：`ml-job.entity.ts` 的 `custom_index_compute` 联合类型可保留或注释 deprecated。

### Phase 5 — 测试

| 测试 | 路径 | 要点 |
|------|------|------|
| 权重 PIT | `custom-index-weight-resolver.spec.ts` | port Python `test_weight_resolver.py` |
| 价格指数 | `custom-index-price-index.spec.ts` | 2 成分等权手工验算 |
| 链式链接 | `custom-index-chain-link.spec.ts` | 版本切换日连续 |
| Service 集成 | `custom-index-compute.runner.spec.ts` | mock DataSource，跑小样本 |
| SSE | `custom-index-sse.controller.spec.ts` | 轮询终态 complete |
| 回归 | `custom-index.service.spec.ts` | 不再 mock ml.jobs |

**验证命令**：

```powershell
pnpm --filter @cryptotrading/server exec jest custom-index --no-cache
pnpm --filter @cryptotrading/server build
pnpm --filter @cryptotrading/web type-check
cd apps/quant-pipeline; uv run pytest tests/custom_index/ -q   # 删除前最后对照；删后跳过
```

### Phase 6 — 文档

- 更新 spec `04-api-and-jobs.md`：删除 ml.jobs / worker 章节，改为 NestJS Runner + SSE 轮询。
- 更新 `CLAUDE.md` 常用命令说明：**自定义指数不再要求 quant worker**。
- 本 handoff 完成后可移入 `prompts/archive/`。

---

## 可复用的 NestJS 现有代码

| 能力 | 参考文件 |
|------|----------|
| 指数指标 MA/MACD/KDJ/BBI/砖图 | `ths-index-daily-indicator.service.ts` + `indicators/indicators.ts` |
| AMV 公式 + MACD | `active-mv/amv-formula.ts`（`getAmv()` 已用 `calcMacd`） |
| 宽基资金流 PIT 等权 SUM | `money-flow/money-flow-aggregation.service.ts` → `aggregateIndex()` |
| 批量 UPSERT | `market-data/_shared/sync-helpers.ts` → `batchUpsert` |
| 异步 fire-and-forget 模式 | `one-click-sync-orchestrator.service.ts`（`setImmediate`） |

---

## Python → TypeScript 对照要点（易错）

1. **`base_point` 落在 `actual_start_date`**，不是用户填的 `base_date`（见 spec 03 §actual-start-date）。
2. **停牌日**：成分权重对可交易成分再归一化。
3. **全收益 fallback**：某日缺分红数据 → 该日按价格指数口径，写 warning 日志，**不改** `index_type`。
4. **资金流**：等权 SUM，**不用** `members.weight` 加权。
5. **日期**：全程 `YYYYMMDD` 字符串，禁止 `new Date()` 解析业务日（见 `.claude/rules/datetime.md`）。
6. **`full_rebuild`**：DELETE 该指数 quotes/indicators/money_flow/amv 后全量重算。

---

## 端到端验收

前提：Migration 已执行；`pnpm dev` 启动（**无** quant worker）。

1. 登录 → 标的 → A 股数据 → A 股指数 → **我的指数** → **创建指数**。
2. 选 2–5 只 familiar 成分（如 600519.SH + 000858.SZ），等权，基期选有数据的近期交易日，价格指数。
3. 提交后列表行 `status=computing`，progress 递增，**无需** Python 进程。
4. 终态 `ready` 后点击行 → K 线 Modal 有 OHLC + VOL/KDJ/MACD + 0AMV 副图。
5. 编辑成分 → 保存并重算 → 新版本链生效，曲线无异常跳空（chain link）。
6. 「成分股」跳转 → 股票 tab 仅显示 custom 成分（依赖 `POST /a-shares/query` 的 `tsCodes`，**已实现**）。

**DB 抽查**：

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT status, compute_progress, compute_stage FROM custom_index_definitions ORDER BY updated_at DESC LIMIT 5;"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT COUNT(*) FROM custom_index_daily_quotes WHERE custom_index_id = '<uuid>';"
```

---

## 风险与权衡

| 风险 | 缓解 |
|------|------|
| 大 basket + 长历史阻塞 Node 事件循环 | 分块计算 + 块间 yield；必要时限制最大回算年数（spec 未限，V1 可 log warning） |
| 进程重启导致 computing 悬挂 | 启动时把 `status=computing` 标为 `failed` + `last_error=interrupted`（可选 startup hook） |
| 与 Python 实现数值漂移 | port 同一组 fixture 测试；选 2 成分 10 日 snapshot 对比 |
| SSE 轮询 vs NOTIFY | 1s 轮询足够；computing 行通常仅一条 |

---

## 不要做的事

- 不要把计算放回同步 HTTP（POST 会超时）。
- 不要重新引入 `POST /api/quant/jobs` 给普通用户。
- 不要把 custom 指数写入 `index_daily_quotes`（spec 方案 1 独立表）。
- 不要在本任务中改前端 Modal 步骤或 UX。

---

## 建议 PR 切分

1. **PR1**：NestJS Runner + 单测（无接线，feature flag 可选）
2. **PR2**：ComputeService 改 schedule + SSE 轮询 + 删 Python
3. **PR3**：文档 + spec 04 更新

---

## 会话启动提示词（可复制）

```text
请阅读并执行交接文档：
prompts/migrate-custom-index-compute-to-nestjs.md

目标：自定义指数计算从 Python quant worker 迁到 NestJS，使用户只需 pnpm dev 即可创建并查看自定义指数 K 线。

从 Phase 1 开始，先读 Python 参考实现 apps/quant-pipeline/src/quant_pipeline/custom_index/，
再读 spec docs/superpowers/specs/2026-06-28-custom-index-create-design/03-index-computation.md。
完成后跑 custom-index 相关 Jest 并做端到端验收。
```
