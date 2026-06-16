# 05 · NestJS 模块与 API 契约

> 新建 `apps/server/src/market-data/us-index-amv/`，镜像 `us-index-daily/`（已逐文件核验）。
> Controller **禁** `@UseGuards(AuthGuard)`（全局已注册，`.claude/rules/nestjs.md`）。改后端**必须重启**
> （`nest start` 无 watch）。

## 1. 实体（`entities/raw/`）

照 [us-index-daily-quote.entity.ts] / [us-index-daily-indicator.entity.ts] 风格：
`@Entity({schema:'raw', name:'...'})` + `@Unique([camelCase])`；PK `@PrimaryGeneratedColumn('increment',{type:'bigint'}) id: string`；
`@Index()+@Column({name:'snake'})`；`numeric`→`string`、`double precision`→`number`；
末尾 `@UpdateDateColumn({name:'updated_at', type:'timestamptz'}) updatedAt: Date`。

- `us-index-amv-daily.entity.ts`（表 `raw.us_index_amv_daily`）：`indexCode, tradeDate, amvOpen, amvHigh,
  amvLow, amvClose, amvDif, amvDea, amvMacd, amvZdf, signal, memberCount, updatedAt`。
  `amv*` 为 `double precision`→`number`（可空）；`signal` smallint→`number`；`memberCount` integer→`number`。
- `us-index-constituent.entity.ts`（表 `raw.us_index_constituent`）：`indexCode, ticker, weightPct, name, updatedAt`。
  （查询用裸 SQL，实体主要为双注册 / 未来 ORM 用；本期读名单在 Python 侧，NestJS 不读成分表。）

## 2. 模块（`us-index-amv.module.ts`）

```ts
@Module({
  imports: [
    TypeOrmModule.forFeature([UsIndexAmvDailyEntity, UsIndexConstituentEntity]),
    QuantModule,                       // 派 job 需 QuantJobsService
  ],
  controllers: [UsIndexAmvController],
  providers: [UsIndexAmvService],
})
```

## 3. Controller（`us-index-amv.controller.ts`，镜像 us-index-daily.controller）

`@Controller('us-index-amv')`，三路由：

| 方法 | 路由 | 校验 | 委托 |
|---|---|---|---|
| `@Get()` | `/api/us-index-amv?index_code=&start_date=&end_date=` | `index_code` 必填；`start_date`/`end_date` 须 `/^\d{8}$/` 否则 `BadRequestException` | `service.getSeries(params)` → `AmvSeriesRow[]` |
| `@Get('date-range')` | `/api/us-index-amv/date-range?index_code=` | `index_code` 必填 | `service.getDateRange(indexCode)` |
| `@Post('sync')` `@AdminOnly()` | `/api/us-index-amv/sync` | — | `service.sync(body ?? {}, user?.id ?? null)` → `{ jobId }` |

入参类型用 `interface`（无 class-validator，与 us-index-daily 一致）。

## 4. Service（`us-index-amv.service.ts`）

注入 `DataSource` + `QuantJobsService`（裸 SQL，不注 Repository）。

**`getSeries(index_code, start_date, end_date)` → `AmvSeriesRow[]`**（裸 SQL）：
```sql
SELECT trade_date            AS "tradeDate",
       amv_open AS "amvOpen", amv_high AS "amvHigh", amv_low AS "amvLow", amv_close AS "amvClose",
       amv_dif  AS "amvDif",  amv_dea  AS "amvDea",  amv_macd AS "amvMacd",
       amv_zdf  AS "amvZdf",  signal,  member_count AS "memberCount"
FROM raw.us_index_amv_daily
WHERE index_code = $1 AND trade_date >= $2 AND trade_date <= $3
ORDER BY trade_date ASC;
```
- 返回字段对齐前端 `AmvSeriesRow`（`tradeDate` 为 `YYYYMMDD`，见 [06 日期对齐](./06-frontend.md#3-日期对齐)）。
- 数值列经 `asNullableNumber`（import 自 `../us-index-daily/utils/us-index-format.util`，**注意有
  `utils/` 子目录**；`asNullableNumber:6` / `formatTradeDateLabel:13`）转 number/null。
- **裸 SQL 用 SELECT 别名水合**，不走 QueryBuilder `.select()`（规避 `.claude/rules/database-sql.md` 的
  实体属性名水合坑；裸 query 用别名最稳）。

**`getDateRange(index_code)`**：`MIN/MAX(trade_date) FROM raw.us_index_amv_daily WHERE index_code=$1`，
空表 `{start:null,end:null}`。

**`sync(body, createdBy)` 派 job**（镜像 us-index-daily.service.sync）：
```ts
const params: Record<string, unknown> = {};
if (body.dateRange) params.date_range = `${body.dateRange[0]}:${body.dateRange[1]}`;  // 冒号串
if (body.symbols)   params.symbols = body.symbols;
const dto: ValidatedCreateJob = { runType: 'us_index_amv_sync', params, priority: 100, maxAttempts: 1 };
const job = await this.quantJobs.create(dto, createdBy);
return { jobId: job.id };
```
- `body: { dateRange?: [string,string]; symbols?: string[] }`（camelCase，与 UsIndexSyncBody 同构）。
- `date_range` 存**冒号字符串**（非数组），缺省由 Python dispatcher 兜底全量。

## 5. 实体双注册

（`project_typeorm_entity_dual_registration` 教训：漏根 `entities[]` → 运行时 `EntityMetadataNotFound` 500）

- `app.module.ts`：顶部 import 两实体；根 `entities[]`（[app.module.ts:135-137] 美股指数段后）追加
  `UsIndexAmvDailyEntity, UsIndexConstituentEntity`；imports 数组（[app.module.ts:234] 附近）加
  `UsIndexAmvModule`。
- 漏根 `entities[]` → 编译绿但运行时 `EntityMetadataNotFound` 500。

## 6. 契约要点

- GET 返回 `AmvSeriesRow[]`（与前端 `active-mv.ts` 的 `AmvSeriesRow` 同构，前端复用该类型）。
- `tradeDate` 出参 `YYYYMMDD`（库内即此格式，**不**转 `YYYY-MM-DD`；前端 `normalizeDateKey` 去横线对齐，
  见 [06](./06-frontend.md#3-日期对齐)）。
- run_type 三处见 [02 §3](./02-data-model.md#3-run_type-check-约束加-us_index_amv_sync三处镜像缺一即-post-派-job-撞约束-500)。
