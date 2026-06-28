# 场景：Schema 内表清单

## Purpose

列出指定 schema 下所有 BASE TABLE，用于核对 migration 是否落地或快速定位表名。

## Tables & Columns

- `information_schema.tables` — `table_schema`, `table_name`, `table_type`
- 本库 5 个业务 schema：`public`, `raw`, `factors`, `ml`, `research`

## Example SQL

```sql
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema IN ('public', 'raw', 'factors', 'ml', 'research')
  AND table_type = 'BASE TABLE'
  AND table_name NOT LIKE 'pg_%'
ORDER BY table_schema, table_name;
```

单 schema 过滤示例：

```sql
SELECT table_name
FROM information_schema.tables
WHERE table_schema = 'raw'
  AND table_type = 'BASE TABLE'
ORDER BY table_name;
```

## Pitfalls

- 不含 VIEW / MATERIALIZED VIEW；若需视图清单另查 `table_type IN ('VIEW', 'MATERIALIZED VIEW')`。
- 全库清单须包含 `public`, `raw`, `factors`, `ml`, `research` 五个 schema。
- 表名为 snake_case；查结构用 `\d schema.table`（见 [table-structure-describe](./table-structure-describe.md)）。
