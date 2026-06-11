---
name: db-inspect
description: 对 PostgreSQL 数据库执行只读检查时使用。通过 docker exec psql 快速查询表结构、行数统计、日期范围、数据覆盖和完整性。触发词：查数据库、检查表、行数、数据覆盖、schema、docker exec psql、DB 状态。
---

# DB Inspect（数据库检查）

## 概述

通过 `docker exec crypto-postgres psql` 执行**只读**查询，快速了解数据库状态。每次量化数据开发、回填验证、因子/标签计算后都需要用到。

## 连接模板

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "<SQL>"
```

多条 SQL 用多个 `-c`：

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT ..." -c "SELECT ..."
```

## 常用查询模式

### 1. 表行数 + 日期范围（最常用）

```sql
SELECT count(*) AS rows,
       count(DISTINCT trade_date) AS days,
       min(trade_date) AS min_d,
       max(trade_date) AS max_d
FROM <schema>.<table>;
```

适用场景：确认 raw.daily_quote / factors.daily_factors / factors.labels 等表的数据覆盖。

### 2. Schema 内所有表清单

```sql
SELECT table_schema, table_name
FROM information_schema.tables
WHERE table_schema IN ('raw', 'factors', 'ml', 'public')
  AND table_name NOT LIKE 'pg_%'
ORDER BY table_schema, table_name;
```

### 3. 特定表结构（\d）

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d raw.daily_quote"
```

### 4. 因子覆盖检查

```sql
SELECT factor_id, factor_version,
       count(*) AS rows,
       count(DISTINCT trade_date) AS days,
       min(trade_date) AS min_d,
       max(trade_date) AS max_d
FROM factors.daily_factors
GROUP BY factor_id, factor_version
ORDER BY factor_id;
```

### 5. 特定交易日的因子完整性

```sql
SELECT ts_code, count(*) AS factor_cnt,
       string_agg(DISTINCT factor_id, ',') AS factors
FROM factors.daily_factors
WHERE trade_date = '<YYYYMMDD>' AND factor_version = 'v1'
  AND ts_code IN (SELECT ts_code FROM raw.daily_quote WHERE trade_date = '<YYYYMMDD>' LIMIT 20)
GROUP BY ts_code
ORDER BY factor_cnt DESC;
```

### 6. 缺失数据检测

```sql
WITH expected AS (
  SELECT ts_code FROM raw.daily_quote WHERE trade_date = '<YYYYMMDD>'
),
actual AS (
  SELECT DISTINCT ts_code FROM factors.daily_factors
  WHERE trade_date = '<YYYYMMDD>' AND factor_id = '<factor_id>'
)
SELECT count(*) AS missing_count
FROM expected WHERE ts_code NOT IN (SELECT ts_code FROM actual);
```

### 7. Quality Reports 检查

```sql
-- 汇总
SELECT level, rule, count(*) FROM ml.quality_reports GROUP BY level, rule ORDER BY level, rule;
-- Critical 详情
SELECT trade_date, level, rule, detail FROM ml.quality_reports WHERE level = 'critical' LIMIT 20;
```

### 8. ml.jobs 状态

```sql
SELECT status, count(*) FROM ml.jobs GROUP BY status ORDER BY count DESC;
-- 最近的 job
SELECT id, job_type, status, created_at, finished_at FROM ml.jobs ORDER BY created_at DESC LIMIT 5;
```

### 9. 标签表检查

```sql
SELECT scheme, count(*) AS rows,
       count(DISTINCT trade_date) AS days,
       min(trade_date) AS min_d,
       max(trade_date) AS max_d
FROM factors.labels
GROUP BY scheme;
```

### 10. A 股基础表覆盖

```sql
SELECT count(*) AS total,
       count(*) FILTER (WHERE l1_code IS NULL) AS null_l1,
       min(in_date) AS earliest
FROM raw.stock_basic;
```

## 注意事项

- **只读操作**：所有查询均为 SELECT，不要在此 skill 中执行 INSERT/UPDATE/DELETE。
- **PowerShell 编码**：SQL 中的中文在 PowerShell GBK 环境下可能乱码，优先用英文别名（AS rows, AS days）。
- **多表对比时用多个 `-c`**：比 UNION 更清晰，输出自动分段。
- **长输出截断**：加 `LIMIT` 防止输出过大；统计查询优先用 count/agg 而非 SELECT *。
