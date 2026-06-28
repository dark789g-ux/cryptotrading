# Runner 架构与 Stage 管线

## 模块位置

```text
apps/server/src/market-data/custom-index/
├─ custom-index.module.ts              # 注册 Runner + 各 writer/service
├─ custom-index-compute.service.ts     # scheduleCompute（Phase 2 改造）
├─ compute/
│   ├─ custom-index-compute.runner.ts       # Stage 1–7 编排
│   ├─ custom-index-weight-resolver.ts      # PIT 版本链
│   ├─ custom-index-price-index.ts          # 价格指数 Laspeyres
│   ├─ custom-index-total-return.ts         # 全收益 + fallback
│   ├─ custom-index-quotes-writer.ts        # UPSERT quotes
│   ├─ custom-index-indicator.service.ts    # 衍生指标
│   ├─ custom-index-money-flow.service.ts   # 等权 SUM 资金流
│   └─ custom-index-amv-writer.ts           # AMV 序列落库
└─ ...
```

## Stage 管线 {#stage-pipeline}

```text
CustomIndexComputeRunner.run({ customIndexId, userId, fullRebuild })
│
├─ Stage 1  load_members       progress=5   stage=load_members
│           加载 definition + 权重版本链 + members
│           full_rebuild: DELETE quotes/indicators/money_flow/amv
│           UPDATE status=computing
│
├─ Stage 2  sync_quotes        progress=15  stage=sync_quotes
│           只读 DB：批量读成分 OHLCV、adj_factor、meta（trade_cal 校验）
│           （不触发 Tushare / 外部 sync；stage 名沿用 Python 对照）
│
├─ Stage 3  compute_quotes     progress=50  stage=quotes
│           price_index / total_return → UPSERT custom_index_daily_quotes
│           写 actual_start_date
│
├─ Stage 4  indicators         progress=60  stage=indicators
│           calcIndicators + calcBrickChartPoints → custom_index_daily_indicators
│
├─ Stage 5  money_flow         progress=70  stage=money_flow
│           PIT 成分等权 SUM → custom_index_money_flow
│
├─ Stage 6  amv                progress=80  stage=amv
│           calcAmvSeries → custom_index_amv
│
└─ Stage 7  finalize           progress=100 stage=finalize
            status=ready, last_error=null
```

进度字段写入 `custom_index_definitions`：

| 字段 | 值域 |
|------|------|
| `status` | `pending` → `computing` → `ready` \| `failed` |
| `compute_progress` | 5 → 15 → 50 → 60 → 70 → 80 → 100 |
| `compute_stage` | 见上表 stage 名 |
| `last_error` | 失败时写入；成功清空 |

失败路径：任意 stage 抛错 → `status=failed` + `last_error` + `runner.run().catch()` 打 log。

## 文件职责与 Python 对照

| 文件 | 职责 | Python |
|------|------|--------|
| `custom-index-weight-resolver.ts` | 按 trade_date 解析 PIT 成分与 weight | `weight_resolver.py` |
| `custom-index-price-index.ts` | 链式 Laspeyres 价格指数 | `price_index.py` |
| `custom-index-total-return.ts` | 全收益；缺数据 fallback + warning | `total_return.py` |
| `custom-index-quotes-writer.ts` | 批量 UPSERT `custom_index_daily_quotes` | `compute.py` Stage 3 |
| `custom-index-indicator.service.ts` | MA/MACD/KDJ/BBI/砖图 | `indicators.py` |
| `custom-index-money-flow.service.ts` | 等权 SUM（**非** weight 加权） | `money_flow.py` |
| `custom-index-amv-writer.ts` | AMV 序列 | `amv.py` |
| `custom-index-compute.runner.ts` | 编排 + progress 更新 | `compute.py` |

## 数据读取（PostgreSQL，只读）

| 用途 | 表 / 来源 |
|------|-----------|
| 成分 OHLCV | `raw.daily_quote`（或项目内 a-share 查询层 qfq 字段） |
| 复权因子 | `raw.adj_factor` |
| 流通市值 | `raw.daily_basic.float_mv`（preview-weights 已有 NestJS 查询可复用） |
| 资金流 | `money_flow_stocks` |
| 交易日历 | `raw.trade_cal`（校验 base_date / effective_date） |
| 成分 meta | `a_share_symbols` |

## 数据写入

| 表 | 阶段 |
|----|------|
| `custom_index_daily_quotes` | Stage 3 |
| `custom_index_daily_indicators` | Stage 4 |
| `custom_index_money_flow` | Stage 5 |
| `custom_index_amv` | Stage 6 |
| `custom_index_definitions` | 全程 progress/status |

UPSERT 使用 `batchUpsert`（`_shared/sync-helpers.ts`）。

## 指标计算模式

照抄 `ThsIndexDailyIndicatorService`：

```text
读 custom_index_daily_quotes (OHLCV 序列)
    → calcIndicators()     # apps/server/src/indicators/indicators.ts
    → calcBrickChartPoints() # brick-chart.ts
    → batchUpsert → custom_index_daily_indicators
```

只持久化 MA / MACD / KDJ / BBI / BRICK 字段 subset（与 THS 指数指标服务一致）。

## 资金流

**与宽基 `aggregateIndex()` 不同**：custom index 用 **等权 SUM**。

```text
for trade_date in range:
    pit_members = resolve_pit_members(versions, trade_date)
    for con_code in pit_members:
        flow = money_flow_stocks[trade_date, con_code]
        net += flow.net_amount   # 不加权 members.weight
```

参考 Python `money_flow.py`；不可照搬 `money-flow-aggregation.service.ts` 的 SQL 加权逻辑。

## AMV

- **写库**：Runner Stage 6 用 `calcAmvSeries`（`amv-formula.ts`）写入 `custom_index_amv`
- **读 API**：保持现有 `CustomIndexService.getAmv()`（DB amv 列 + 运行时 `calcMacd`）— **不改**

## 并发控制

```text
内存 Map<customIndexId, { abort?: AbortSignal }>
        +
DB status=computing 双重检查
```

| 场景 | 行为 |
|------|------|
| 已在 computing | PATCH / recompute → **409**（已有） |
| delete while computing | **409**（与前端 `customIndexColumns` disabled 一致；迁移时补后端校验） |
| 同一指数重复 schedule | V1：**拒绝**并 log；不排队 |

`cancelLatestJob()`：**删除**（ml.jobs 移除后无 cancel 对象）。`remove()` 在 `status=computing` 时直接 409，不再尝试 cancel。

## Event loop 分块

长历史按 **250 交易日/块** 处理 quotes / indicators / money_flow / amv：

```text
for chunk of tradeDatesByChunk(250):
    await computeChunk(chunk)
    await yieldEventLoop()   // setImmediate 或 setTimeout(0)
```

超大 basket（如 >10 年）可 log warning，V1 不硬限年数。

## 模块注册

`custom-index.module.ts` 需新增 providers：

- `CustomIndexComputeRunner`
- `CustomIndexIndicatorService`（**独立 service**，与其它 writer 对称，便于单测 mock）
- 各 writer / resolver 按需 inject `DataSource` / repos

`CustomIndexComputeService` 注入 `CustomIndexComputeRunner`，删除 `MlJobEntity` repository 依赖。
