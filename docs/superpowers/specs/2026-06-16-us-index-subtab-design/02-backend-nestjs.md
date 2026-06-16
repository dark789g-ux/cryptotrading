# 02 · 后端 NestJS 模块 `market-data/us-index-daily/`

← 返回 [index.md](./index.md) | 依赖 [01 实体](./01-data-model.md)

结构**镜像 ths-index-daily**（只读 raw SQL + date-range），同步部分**镜像 us-stocks**（POST /sync 派 ml.jobs）。Controller **禁** `@UseGuards(AuthGuard)`（全局已注册，`.claude/rules/nestjs.md`）。

## 目录与文件

```text
apps/server/src/market-data/us-index-daily/
  us-index-daily.module.ts        forFeature[QuoteEntity, IndicatorEntity] + imports QuantModule(派 job)
  us-index-daily.controller.ts    3 端点
  us-index-daily.service.ts       getKlines / getDateRange / sync
  us-index-daily.types.ts         UsIndexQueryParams / UsIndexSyncBody / KlineRow
  utils/us-index-format.util.ts   asNumber / asNullableNumber / formatTradeDateLabel（照 us-stocks util 各模块自带一份）
  us-index-daily.service.spec.ts  jest
```

并在 [app.module.ts](../../../../apps/server/src/app.module.ts) `imports: [...]` 注册 `UsIndexDailyModule`（照 `UsStocksModule` / `ThsIndexDailyModule`）。

## 端点契约

| 端点 | 方法 | 入参 | 出参 |
|------|------|------|------|
| `GET /api/us-index-daily` | `getKlines` | query `index_code`(必填) `start_date`(YYYYMMDD 必填) `end_date`(YYYYMMDD 必填) | `KlineChartBar[]` |
| `GET /api/us-index-daily/date-range` | `getDateRange` | query `index_code`(必填) | `{ start: string \| null, end: string \| null }`（YYYYMMDD） |
| `POST /api/us-index-daily/sync` | `sync` | body `{ dateRange?: [YYYYMMDD,YYYYMMDD], symbols?: string[] }`；`@AdminOnly()` `@CurrentUser()` | `{ jobId: string }` |

- 全局 `/api` 前缀；controller `@Controller('us-index-daily')`。
- 三参校验：缺 `index_code`/`start_date`/`end_date` → `BadRequestException`。

## service.getKlines（raw SQL，镜像 ths-index-daily.service:51-117）

```sql
SELECT q.trade_date,
       q.open, q.high, q.low, q.close, q.volume,
       i.ma5, i.ma30, i.ma60, i.ma120, i.ma240, i.bbi,
       i.kdj_k, i.kdj_d, i.kdj_j, i.dif, i.dea, i.macd
FROM raw.us_index_daily q
LEFT JOIN raw.us_index_indicator i
       ON i.index_code = q.index_code AND i.trade_date = q.trade_date
WHERE q.index_code = $1 AND q.trade_date >= $2 AND q.trade_date <= $3
ORDER BY q.trade_date ASC
```

经 `this.dataSource.query(...)`。映射成 `KlineChartBar`（类型见 [symbols.ts:24-64](../../../../apps/web/src/api/modules/market/symbols.ts)）：

```text
open_time : formatTradeDateLabel(trade_date)   ── YYYYMMDD → 'YYYY-MM-DD'（决策8）
open/high/low/close/volume : asNumber(...)
MA5/MA30/MA60/MA120/MA240  : asNullableNumber(...)        ── 主图均线
'KDJ.K' / 'KDJ.D' / 'KDJ.J': asNullableNumber(kdj_k/kdj_d/kdj_j)   ── 平铺点键!
DIF/DEA/MACD : asNullableNumber(...)
BBI : asNullableNumber(bbi)                              ── 主图叠加线
```

- ⚠️ **KDJ 是平铺字符串点键 `'KDJ.K'/'KDJ.D'/'KDJ.J'`，不是嵌套对象 `{K,D,J}`**——`KlineChartBar`（[symbols.ts:36-38](../../../../apps/web/src/api/modules/market/symbols.ts)）即此结构，已对照 [ths-index-daily.service:104-110](../../../../apps/server/src/market-data/ths-index-daily/ths-index-daily.service.ts) 与 us-stocks.service:207-211 核实。写成嵌套对象前端副图读不到 KDJ。
- SELECT 列 = 前端 `['VOL','KDJ','MACD']` 副图 + 主图叠加（VOL=volume，KDJ，MACD=DIF/DEA/MACD，MA 均线，BBI 叠加线）；`atr_14/low_9/high_9/stop_loss_pct/risk_reward_ratio` 入库但 K 线**不取**（前端不渲染、`KlineChartBar` 无对应字段）。
- ⚠️ **raw SQL 直接写 DB 列名**（`kdj_k` 等），不走 TypeORM QueryBuilder `.select()`，故不受 `.claude/rules/database-sql.md` 的「属性名水合」坑约束；但仍须与 01 的 DDL 列名字面一致。

## service.getDateRange

`SELECT min(trade_date) AS start, max(trade_date) AS end FROM raw.us_index_daily WHERE index_code = $1`，空表返回 `{ start: null, end: null }`。前端用它定首屏区间。

## service.sync（镜像 us-stocks.service.sync:230-264）

派 `us_index_sync` job（写一行 ml.jobs，复用 `QuantJobsService.create`）：

```text
body(前端传, 校验后转 params):
  body.dateRange?: [YYYYMMDD, YYYYMMDD]   校验二元组 + YYYYMMDD_RE + start<=end, 否则 400
  body.symbols?:   string[]               校验非空字符串数组, 否则 400
params(snake_case 落 ml.jobs, Python worker 读):
  date_range?: 'YYYYMMDD:YYYYMMDD'   ⚠️ 存冒号字符串(非数组!) = dateRange[0]+':'+dateRange[1]; body 无则省略该键
  symbols?:    string[]              缺省时 worker 默认 ('.NDX',)
dto = { runType: 'us_index_sync', params, priority: 100, maxAttempts: 1 }
job = await this.quantJobs.create(dto, createdBy)   -- createdBy 来自 @CurrentUser().id
return { jobId: job.id }
```

> ⚠️ **不沿用 us-stocks 的 date_range 存法**：us-stocks.service.sync 存的是**数组** `params.date_range = range`（[us-stocks.service.ts:246](../../../../apps/server/src/market-data/us-stocks/us-stocks.service.ts)），但 Python `_runner_us_sync` **严格要求冒号字符串**（[dispatcher.py:142-146](../../../../apps/quant-pipeline/src/quant_pipeline/worker/dispatcher.py) `not isinstance(date_range, str) or ':' not in date_range → ValueError`）——这是 us-stocks 的 latent bug（UI 同步按钮无参提交 → worker 必抛 ValueError）。本模块**存冒号串**，且 Python runner 对缺省 date_range **兜底默认全量**（见 [03 §4](./03-python-pipeline.md)），保证 UI 无参同步真能跑通。

## ⚠️ run_type 枚举守门（两处必加，否则 create() 拒绝）

`us_index_sync` 是新 run_type，须同步加入：

1. [ml-job.entity.ts:50-51](../../../../apps/server/src/entities/ml/ml-job.entity.ts) 的 `runType` 联合类型：现有 `| 'us_sync'`，追加 `| 'us_index_sync'`。
2. [create-job.dto.ts:75](../../../../apps/server/src/modules/quant/dto/create-job.dto.ts) 的允许 run_type 列表（现含 `'us_sync'`），追加 `'us_index_sync'`。

> 这是 memory「枚举守门收敛」教训：漏加会让 POST /sync 在 `create()` 校验处被拒。`us_index_sync` 与 `us_sync` 同属「非 LABEL_REF / FEATURE_SET」run_type，create() 不展开 labelRef、不校验 feature_set，直接落 pending。

## jest（service.spec）

- `getKlines`：mock `dataSource.query` 返回 2 行（含 null 指标）→ 断言映射后 `open_time === 'YYYY-MM-DD'`、`KDJ.K` 取到、null 指标透为 `null`、顺序升序。
- `getDateRange`：空结果 → `{start:null,end:null}`；有结果 → 取 min/max。
- `sync`：无参 → `dto.runType==='us_index_sync'`、`params={}`（**无 date_range 键**）、透传 createdBy、返回 jobId；传 `dateRange:['20240101','20240131']` → `params.date_range==='20240101:20240131'`（**冒号串，非数组**）；`dateRange` 非二元组/非 YYYYMMDD/start>end → 抛 `BadRequestException`；`symbols` 含空串 → 400。

## 验证

`pnpm --filter @cryptotrading/server build` 绿 + `exec jest us-index-daily` 全过 + 后端重启后 `GET /api/us-index-daily/date-range?index_code=.NDX` 返回真实区间。
