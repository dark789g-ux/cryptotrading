# 场景：因子覆盖（按 factor_id / version）

## Purpose

按 `factor_id` + `factor_version` 汇总行数与日期范围，确认各因子版本是否已计算、覆盖区间是否对齐预期。

## Tables & Columns

- `factors.daily_factors` — `factor_id`, `factor_version`, `trade_date`, `ts_code`, `value`

## Example SQL

```sql
SELECT factor_id, factor_version,
       count(*) AS rows,
       count(DISTINCT trade_date) AS days,
       min(trade_date) AS min_d,
       max(trade_date) AS max_d
FROM factors.daily_factors
GROUP BY factor_id, factor_version
ORDER BY factor_id, factor_version;
```

## Table Structure (on demand)

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d factors.daily_factors"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.daily_quote"
```

## Pitfalls

- `factors.daily_factors` 为分区父表；全表 `GROUP BY` 可能较慢，可按 `trade_date` 范围加 `WHERE` 缩小扫描。
- `factor_version` 须与计算任务配置一致（常见 `v1`）；勿与 `factor_id` 混淆。
- 行数期望 ≈ 交易日数 × 当日 universe 股票数（停牌/缺失会导致偏差）。
