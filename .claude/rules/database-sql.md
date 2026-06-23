---
paths:
  - "apps/server/**/*.ts"
---

# 数据库 & SQL

## Schema 变更走 migrations

`synchronize: false`（已设），所有 schema 变更走 `migrations/*.sql`。

## 原生 SQL 数组参数强转须与列类型匹配

- `character varying` 用 `::text[]`
- `uuid` 列用 `::uuid[]`（如 `watchlist_items.watchlist_id` 是 `uuid`，误用 `::text[]` 会 500）

## TypeORM andWhere 字符串里禁 `'[]'::jsonb`

会误绑 `:jsonb`，用 `CAST('[]' AS jsonb)` 代替。

## 禁同表 leftJoin 再 getManyAndCount+orderBy

TypeORM 0.3 空 metadata 已知坑。

## TypeORM QueryBuilder `.select()` 用实体属性名，不用 DB 列名

`getMany()` 按**实体属性名**水合结果。`.select(['s.ts_code', 's.rank_in_day'])`（DB 列名）会让 `tsCode`/`rankInDay` 水合不上 → `undefined`，JSON 序列化后字段**静默丢失**；只有列名恰好等于属性名的字段（如 `score`）幸存。

必须写属性名：`.select(['s.tsCode', 's.rankInDay'])`。不限制列时直接 `getMany()`（取全实体）反而最稳。

**陷阱**：mock QueryBuilder 的单测只校验"`select` 被以某串参数调用"，验不出水合是否正确 → 这类查询必须靠真机/集成验证，单测全绿不等于字段对。

**教训**：quant-scores 的 `listScores`/`getScoresByTsCodes` 因 `.select([...])` 写 DB 列名，`ts_code`/`rank_in_day` 线上返回 undefined，单测却全绿。

## 动态 SQL 构建禁止直接拼接前端字段名

如 `i.${field}`：必须经过 `FIELD_COL_MAP` 翻译为实际列名，未命中映射记 `logger.warn` 并跳过。

## TypeORM upsert 前必须按 conflictKeys 去重

保留最后一条。PostgreSQL `ON CONFLICT DO UPDATE` 同批次重复键会报 `cannot affect row a second time`（500）。

第三方返回重复行需 `logger.warn` + 原始/去重后条数。

## 500 报错排查

开 TypeORM `logging: ['error','warn']`（已开）+ `logger.error(err.stack)`，禁静态分析猜。
