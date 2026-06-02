# 02 · 扶正后端：概念板块独立成一级类别

← 返回 [`./index.md`](./index.md)

采用**方案 B（双表）**：新建 `concept_amv_daily`，`industry_amv_daily` 收紧为只存 `type='I'`。

## 数据模型：新表 `concept_amv_daily`

新建实体 `apps/server/src/entities/active-mv/concept-amv-daily.entity.ts`，
**列定义与 `industry-amv-daily.entity.ts` 完全一致**（同一套 AMV 双 join 算法的产物）：

```text
concept_amv_daily (public)
  id            bigint  PK 自增
  ts_code       varchar         概念指数代码（.TI，type='N'）
  trade_date    varchar(8)      YYYYMMDD
  amv_open/high/low/close   double precision  nullable
  amv_dif/dea/macd/zdf      double precision  nullable
  signal        smallint  NOT NULL            -1/0/1
  member_count  integer   nullable            当日有成交额的成分股数
  updated_at    timestamptz NOT NULL
  UNIQUE(ts_code, trade_date)                 uq_concept_amv_daily_code_date
  INDEX(ts_code, trade_date)                  idx_concept_amv_daily_code_date
  INDEX(trade_date, signal)                   idx_concept_amv_daily_date_signal
```

建表脚本见 [`./03-migration.md`](./03-migration.md)。

## Service 参数化（消除重复，修复病根）

现状：`industry-amv.service.ts` 持有全部双 join 算法；`resolveIndexCodes()`
（`industry-amv.service.ts:168-181`）只 `WHERE m.tsCode LIKE '%.TI'`、**无 type 过滤**——这是
行业/概念混存的病根。

### 重构方案

将 `IndustryAmvService` **泛化为 `ThsIndexAmvService`**（单 service、参数化 by type），
注入两个结果表 repo：

```text
ThsIndexAmvService（原 IndustryAmvService 改名/泛化）
  注入: industryAmvRepo (type I), conceptAmvRepo (type N),
        memberRepo, indexDailyRepo, dailyQuoteRepo, catalogRepo(新增)
  私有: resolveIndexCodes(indexType: 'I'|'N', tsCodes?)   ← 加 type 过滤
        syncByType(indexType, targetRepo, opts)           ← 抽出共享算法主体
        getSeriesByType(indexType, targetRepo, tsCode, days)
        getSignalsByType(indexType, targetRepo, tradeDate)
  公开: syncIndustry/getIndustry/getIndustrySignals       → ('I', industryAmvRepo)
        syncConcept /getConcept /getConceptSignals        → ('N', conceptAmvRepo)
```

> 替代选项（未采纳）：抽 `AbstractThsIndexAmvService` 基类 + 两个子类。单 service 参数化文件更少、
> DI 更直观，与方案 B"service 参数化"一致，故采单 service。

`ActiveMvService` 协调层与 `active-mv.module.ts` 的 provider/注入相应更新（类名、conceptAmvRepo、
`ThsIndexCatalogEntity` repo）。

### `resolveIndexCodes` 病根修复

```text
旧:  SELECT DISTINCT m.ts_code FROM ths_member_stocks m
     WHERE m.ts_code LIKE '%.TI'

新:  SELECT DISTINCT m.ts_code FROM ths_member_stocks m
     JOIN ths_index_catalog c ON c.ts_code = m.ts_code
     WHERE c.type = :indexType            -- 'I' 或 'N'
     ORDER BY m.ts_code
     （保留 tsCodes 交集逻辑不变）
```

> 写此 SQL 前按 [`./index.md`](./index.md)「实现前必做的真源核对」第 1 条亲查真 DB 确认 join 命中。
> 列名以实体为准：`ths_index_catalog.ts_code` / `.type`、`ths_member_stocks.ts_code`。

## 新端点（Controller）

`apps/server/src/market-data/active-mv/active-mv.controller.ts` 在现有 stock/industry 路由旁
**镜像新增 concept 三个路由**：

```text
POST /api/active-mv/concept/sync        @AdminOnly  body: ThsIndexAmvSyncOptions
GET  /api/active-mv/concept/:tsCode     query days=250   → AmvSeriesRow[]
GET  /api/active-mv/concept/signals     query tradeDate  → AmvSignalRow[]
```

> ⚠️ 路由顺序坑：`/concept/signals` 必须声明在 `/concept/:tsCode` **之前**，否则 `signals` 会被
> 当作 `:tsCode` 路径参数吞掉（NestJS 按声明顺序匹配）。沿用现有 industry 路由的同款顺序。

## 类型（后端 `active-mv.types.ts`）

> AMV 类型**不在** `packages/shared-types`（该包零 AMV 类型），全部定义在
> `apps/server/src/market-data/active-mv/active-mv.types.ts`，已含于 Agent B 文件域。

`IndustryAmvSyncOptions`（`active-mv.types.ts:40-47`，含 `startDate/endDate/syncMode/tsCodes`）
形态对概念完全适用。**复用**该接口或重命名为 `ThsIndexAmvSyncOptions`；不新增字段。
查询返回结构 `AmvSeriesRow` / `AmvSignalRow` 概念与行业共用，无需改。

## fail-fast 断言（概念复用行业同款）

概念指数同为 `.TI` 后缀、成分股同为个股（`.SZ/.SH/.BJ/.NQ`），故现有断言
（`industry-amv.service.ts:189-230`：价侧 `.TI`、量侧 `.SZ/.SH/.BJ/.NQ`、daily_quotes `.TI`）
**整套复用**，泛化后对两类 type 共同生效。

新增一条**类别隔离断言**（防回归）：concept 路径解析出的指数代码，其
`ths_index_catalog.type` 必须全为 `'N'`；industry 路径必须全为 `'I'`。
抽样校验，错配则 `throw`（apiName 标 `amv_type_mismatch`）。

## 验收（本部分）

- `pnpm --filter @cryptotrading/server build` 通过。
- 单测：新增/改 `ThsIndexAmvService` 的 `resolveIndexCodes` 按 type 过滤的用例
  （见 `apps/server/src/market-data/active-mv/*.spec.ts`）。
- `POST /api/active-mv/industry/sync` 不传 tsCodes 时，**只**算 type='I'（不再含 N）。
- `POST /api/active-mv/concept/sync` 只算 type='N'。
