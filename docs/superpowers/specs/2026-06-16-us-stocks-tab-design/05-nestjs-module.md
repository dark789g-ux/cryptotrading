# 05 · NestJS 查询 + 触发模块

新模块 `apps/server/src/market-data/us-stocks/`，镜像 `a-shares/` 分层，但**只读** `raw.us_*` + 写 `us_symbol.tracked` + 派 `ml.jobs`（不算任何衍生数据）。

```text
us-stocks.module.ts            forFeature 注册 4 实体 + providers
us-stocks.controller.ts        @Controller('us-stocks')
us-stocks.service.ts           query/summary/filterOptions/dateRange/klines (镜像 a-shares.service)
us-stocks-symbols.service.ts   列 symbols + 改 tracked
us-stocks.types.ts             UsStockRow / UsStockQueryBody / 等 DTO
sql/us-stocks-query.sql.ts     query builder (priceMode 选 qfq_*/原始列, 排序映射白名单)
```

## 端点（全局前缀 /api）

```text
POST /api/us-stocks/query             筛选/排序/分页, body UsStockQueryBody (镜像 AShareQueryBody)
GET  /api/us-stocks/:ticker/klines    详情K线
GET  /api/us-stocks/summary           汇总(标的数/日期等)
GET  /api/us-stocks/filter-options    主题(theme)/类型 等可选项
GET  /api/us-stocks/date-range        覆盖日期范围
GET  /api/us-stocks/symbols           列 us_symbol(含 tracked)
PUT  /api/us-stocks/symbols/tracked   改 tracked, 统一批量 body: {items:[{ticker,tracked},...]}
POST /api/us-stocks/sync              写 ml.jobs(run_type='us_sync', params:{date_range,tickers?}) → {jobId}
```

## 查询要点

- `priceMode='qfq'` 选 `qfq_open/high/low/close/...`，`'raw'` 选原始列；默认 `qfq`（前复权，技术分析口径）。
- 排序映射白名单（仿 A 股 `RAW_SORT_COL_MAP`）：基础列 + 指标列；JOIN `raw.us_daily_indicator`。
- `UsStockRow`：ticker/name/theme/close/pctChg/volume/... + 指标字段（与前端共享 descriptor key 对齐）。

## run_type 白名单（4 处登记，缺一不可）

与 [01](./01-architecture-and-dataflow.md#us_sync-run_type-与触发双路径) 同一份清单：
1. `create-job.dto.ts` `ALLOWED_RUN_TYPES` 追加 `'us_sync'`。
2. `MlJobRunType` 类型联合追加 `'us_sync'`（`entities/ml/ml-job.entity.ts`，独立定义点）。
3. Python `worker/dispatcher.py` `_ROUTES["us_sync"]`（见 [04](./04-python-sync-pipeline.md#4-orchestrator--cli--worker)）。
4. Python CLI 子命令 `quant us-sync`（见 [04](./04-python-sync-pipeline.md#4-orchestrator--cli--worker)）。

## tracked 写契约

- NestJS `PUT /symbols/tracked` 只 `UPDATE raw.us_symbol SET tracked=:v WHERE ticker=:t`，**不碰** name/theme/日线表。
- Python 播种/全名单同步 `ON CONFLICT DO UPDATE` 时**不写 tracked**。两方按列归属切分，互不覆盖（见 [01](./01-architecture-and-dataflow.md#进程边界关键设计原则)）。

## sync 派 job 桥

- `POST /sync` 复用现有量化 jobs 服务写一行 `ml.jobs`（参考 `modules/quant` 的 job 创建路径），返回 `{jobId}`。
- 前端拿 jobId → 复用量化 jobs 的 SSE（先 `POST /api/quant/jobs/:id/sse-token` 取短期 token，再 query 参数建连）跟进度。
- 本模块**不**自管 SSE，复用量化 jobs 既有机制（避免重造）。
