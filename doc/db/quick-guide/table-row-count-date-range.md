# 场景：表行数与日期范围

## Purpose

快速确认某张含 `trade_date` 的表有多少行、覆盖多少交易日、最早/最晚日期。回填验证、同步后抽查、因子/标签产出检查的第一步。

## Tables & Columns

- `<schema>.<table>` — 替换为目标表；常用列：`trade_date`（`character` / `YYYYMMDD`）
- 示例表：
  - `raw.daily_quote` — `ts_code`, `trade_date`
  - `factors.daily_factors` — `ts_code`, `trade_date`, `factor_id`, `factor_version`
  - `factors.labels` — `ts_code`, `trade_date`, `scheme`

## Example SQL

```sql
SELECT count(*) AS rows,
       count(DISTINCT trade_date) AS days,
       min(trade_date) AS min_d,
       max(trade_date) AS max_d
FROM <schema>.<table>;
```

PowerShell 示例（替换表名）：

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT count(*) AS rows, count(DISTINCT trade_date) AS days, min(trade_date) AS min_d, max(trade_date) AS max_d FROM raw.daily_quote;"
```

## Table Structure (on demand)

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.daily_quote"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d factors.daily_factors"
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d factors.labels"
```

## Pitfalls

- `trade_date` 为 `character` 类型、`YYYYMMDD` 字符串；`min`/`max` 按字典序等价于日期序。
- 分区父表（如 `factors.daily_factors`）查询会扫描全部分区；大表优先用聚合而非 `SELECT *`。
- 无 `trade_date` 列的表（如 `public.a_share_symbols`）不适用本模板，改用行数 + 业务日期列（见 [a-share-symbols-coverage](./a-share-symbols-coverage.md)）。
