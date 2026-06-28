# 场景：标签表覆盖（按 scheme）

## Purpose

按 `scheme` 汇总 labels 行数与日期范围，确认各标签方案是否已生成、区间是否完整。

## Tables & Columns

- `factors.labels` — `scheme`, `trade_date`, `ts_code`, `value`, `exit_reason`, `hold_days`

## Example SQL

```sql
SELECT scheme, count(*) AS rows,
       count(DISTINCT trade_date) AS days,
       min(trade_date) AS min_d,
       max(trade_date) AS max_d
FROM factors.labels
GROUP BY scheme
ORDER BY scheme;
```

单 scheme 抽查：

```sql
SELECT count(*) AS rows,
       count(DISTINCT ts_code) AS symbols,
       min(trade_date) AS min_d,
       max(trade_date) AS max_d
FROM factors.labels
WHERE scheme = '<scheme_name>';
```

## Table Structure (on demand)

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d factors.labels"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.daily_quote"
```

## Pitfalls

- `factors.labels` 为分区父表；与 `daily_factors` 类似，大范围扫描可能较慢。
- `scheme` 字符串须与 labels runner 配置完全一致。
- 存在按月分区子表 `factors.labels_yYYYYmMM`；聚合查询走父表即可。
