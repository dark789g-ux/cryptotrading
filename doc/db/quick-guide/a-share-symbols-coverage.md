# 场景：A 股基础表覆盖

## Purpose

检查 A 股标的 master 表总量、申万一级行业缺失数、最早上市日期，验证 Tushare `stock_basic` 同步与行业回填状态。

## Tables & Columns

- `public.a_share_symbols` — `ts_code`, `list_date`, `delist_date`, `list_status`, `sw_industry_l1_code`, `sw_industry_l2_code`, `sw_industry_l3_code`

## Example SQL

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE sw_industry_l1_code IS NULL) AS null_l1,
       count(*) FILTER (WHERE list_status = 'L') AS listed,
       min(list_date) AS earliest_list_date
FROM public.a_share_symbols;
```

按 `list_status` 分布：

```sql
SELECT list_status, count(*) AS cnt
FROM public.a_share_symbols
GROUP BY list_status
ORDER BY cnt DESC;
```

## Table Structure (on demand)

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d public.a_share_symbols"
```

## Pitfalls

- **不存在 `raw.stock_basic`**：历史 skill/SQL 引用的该表未建；数据在 `public.a_share_symbols`（量化 pipeline `labels/strategy_aware.py` 等已改用本表）。
- 旧模板列名 `l1_code` / `in_date` 对应本表 `sw_industry_l1_code` / `list_date`。
- `list_date` 为 `character` `YYYYMMDD`；与 `raw.daily_quote.trade_date` join 时注意类型一致。
