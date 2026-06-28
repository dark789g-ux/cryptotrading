# 场景：特定交易日因子完整性

## Purpose

抽查某交易日各 `ts_code` 已写入多少因子，快速发现漏算或 partial batch。

## Tables & Columns

- `factors.daily_factors` — `trade_date`, `ts_code`, `factor_id`, `factor_version`
- `raw.daily_quote` — `trade_date`, `ts_code`（当日 universe 样本）

## Example SQL

```sql
SELECT ts_code, count(*) AS factor_cnt,
       string_agg(DISTINCT factor_id, ',' ORDER BY factor_id) AS factors
FROM factors.daily_factors
WHERE trade_date = '<YYYYMMDD>' AND factor_version = 'v1'
  AND ts_code IN (
    SELECT ts_code FROM raw.daily_quote
    WHERE trade_date = '<YYYYMMDD>'
    LIMIT 20
  )
GROUP BY ts_code
ORDER BY factor_cnt DESC;
```

将 `<YYYYMMDD>` 替换为实际交易日，如 `20250627`。

## Table Structure (on demand)

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d factors.daily_factors"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.daily_quote"
```

## Pitfalls

- 子查询 `LIMIT 20` 仅为抽查；全量完整性请用 [missing-data-vs-expected](./missing-data-vs-expected.md)。
- `string_agg` 输出可能很长；生产排查可加 `factor_id = '<id>'` 过滤单因子。
- 停牌日 `daily_quote` 可能无行，导致「预期 universe」与因子表口径不一致。
