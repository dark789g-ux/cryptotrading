# 01 · 数据模型

## 1.1 migration A — `index_daily_quotes` 加估值列

**文件**：`apps/server/src/migration/20260623000001-add-pe-pb-to-index-daily-quotes.sql` + 同名 `.ps1`

```sql
ALTER TABLE index_daily_quotes ADD COLUMN IF NOT EXISTS pe double precision;
ALTER TABLE index_daily_quotes ADD COLUMN IF NOT EXISTS pb double precision;
```

- `pe`/`pb` 均 **nullable**：申万行填值，`market`/`industry`/`concept` 行合法 NULL
- `index_daily_quotes` 现有列不变（见 `apps/server/src/entities/index-daily/index-daily-quote.entity.ts:23-83`）
- `category` 列 `varchar(8)` **无 DB CHECK**（migration `20260622120000-create-unified-index-daily.sql:42` 只是 `VARCHAR(8) NOT NULL`），加 `'sw'` 无需改约束

## 1.2 实体改动 — 加 pe/pb 属性

**文件**：`apps/server/src/entities/index-daily/index-daily-quote.entity.ts`

```ts
  @Column({ type: 'double precision', nullable: true })
  pe: number | null;

  @Column({ type: 'double precision', nullable: true })
  pb: number | null;
```

`category` 属性的 TS 联合类型扩 `'sw'`：
```ts
  @Column({ length: 8 })
  category: 'market' | 'industry' | 'concept' | 'sw';
```

> 跨切面契约：前端 `IndexCategory`（`apps/web/src/components/symbols/a-shares-index/types.ts:11`）同步扩 `'sw'`，见 [04-frontend.md](./04-frontend.md)。

## 1.3 migration B — 新建 `sw_index_catalog` 表

**文件**：`apps/server/src/migration/20260623000002-create-sw-index-catalog.sql` + 同名 `.ps1`

```sql
CREATE TABLE IF NOT EXISTS sw_index_catalog (
  ts_code      VARCHAR(20) PRIMARY KEY,
  name         VARCHAR(100) NOT NULL,
  level        SMALLINT NOT NULL,        -- 1 | 2 | 3
  l1_code      VARCHAR(20),
  l1_name      VARCHAR(100),
  l2_code      VARCHAR(20),
  l2_name      VARCHAR(100),
  l3_code      VARCHAR(20),
  l3_name      VARCHAR(100),
  member_count INTEGER,
  published    BOOLEAN,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
);
CREATE INDEX IF NOT EXISTS idx_sw_index_catalog_level ON sw_index_catalog (level);
```

- **不污染 `ths_index_catalog`**：申万目录来源是 Tushare `index_basic`(market=SW)/`index_classify`，与 ths_index 不同源，独立表命名清晰
- 三级层级冗余存 l1/l2/l3 code+name，前端层级切换直接读，免 JOIN

## 1.4 实体 — `SwIndexCatalog`

**文件**：`apps/server/src/entities/sw-index/sw-index-catalog.entity.ts`（新目录）

字段与 1.3 表一一对应；`level` TS 类型 `1 | 2 | 3`。

## 1.5 双注册（防 EntityMetadataNotFound 500）

新增实体须**两处**注册（教训见项目 memory `project_typeorm_entity_dual_registration`）：

1. `apps/server/src/market-data/sw-index-daily/sw-index-daily.module.ts` 的 `TypeOrmModule.forFeature([SwIndexCatalog, IndexDailyQuote, IndexDailyIndicator])`
2. `apps/server/src/app.module.ts` 根 `entities` 数组加 `SwIndexCatalog`

> migration A 改的是既有 `IndexDailyQuote` 实体（已在 entities 数组），无需重注册；migration B 的 `SwIndexCatalog` 是新实体，两处都要加。

## 1.6 目录灌入口径

`sw_index_catalog` 由 `SwIndexDailySyncService` 全量灌入（拉 `index_classify` market=SW，`batchUpsert` 覆盖），**不进 migration 硬塞**（三级 511 行数据量 + 易变动，走同步灌入）。首次全量同步时灌满。
