# 场景：缺失数据检测（expected vs actual）

## Purpose

对比某日 `raw.daily_quote` universe 与 `factors.daily_factors` 实际写入，统计缺失 `ts_code` 数量。

## Tables & Columns

- `raw.daily_quote` — `trade_date`, `ts_code`（expected universe）
- `factors.daily_factors` — `trade_date`, `ts_code`, `factor_id`, `factor_version`（actual）

## Example SQL

```sql
WITH expected AS (
  SELECT ts_code FROM raw.daily_quote WHERE trade_date = '<YYYYMMDD>'
),
actual AS (
  SELECT DISTINCT ts_code FROM factors.daily_factors
  WHERE trade_date = '<YYYYMMDD>' AND factor_id = '<factor_id>'
    AND factor_version = 'v1'
)
SELECT count(*) AS missing_count
FROM expected
WHERE ts_code NOT IN (SELECT ts_code FROM actual);
```

列出缺失明细：

```sql
WITH expected AS (
  SELECT ts_code FROM raw.daily_quote WHERE trade_date = '<YYYYMMDD>'
),
actual AS (
  SELECT DISTINCT ts_code FROM factors.daily_factors
  WHERE trade_date = '<YYYYMMDD>' AND factor_id = '<factor_id>'
    AND factor_version = 'v1'
)
SELECT e.ts_code
FROM expected e
LEFT JOIN actual a ON e.ts_code = a.ts_code
WHERE a.ts_code IS NULL
ORDER BY e.ts_code
LIMIT 50;
```

## Table Structure (on demand)

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.daily_quote"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d factors.daily_factors"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d public.a_share_symbols"
```

## Pitfalls

- 替换 `<YYYYMMDD>`、`<factor_id>`；版本默认 `v1` 须与 pipeline 一致。
- `NOT IN (SELECT ...)` 在 `actual` 含 NULL 时行为异常；本场景 `DISTINCT ts_code` 通常安全，大表更推荐 `LEFT JOIN ... IS NULL`（见明细 SQL）。
- expected 以 `daily_quote` 为准；若业务 universe 为 `list_status='L'`，需 join `public.a_share_symbols` 另行过滤。
