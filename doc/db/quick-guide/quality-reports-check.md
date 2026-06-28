# 场景：Quality Reports 检查

## Purpose

查看量化数据质量规则触发汇总与 critical 详情，用于 pipeline 跑批后的告警排查。

## Tables & Columns

- `ml.quality_reports` — `trade_date`, `level`（`info` / `warn` / `critical`）, `rule`, `detail`（jsonb）, `created_at`

## Example SQL

汇总：

```sql
SELECT level, rule, count(*) AS cnt
FROM ml.quality_reports
GROUP BY level, rule
ORDER BY level, rule;
```

Critical 详情（最近）：

```sql
SELECT trade_date, level, rule, detail
FROM ml.quality_reports
WHERE level = 'critical'
ORDER BY trade_date DESC, created_at DESC
LIMIT 20;
```

PowerShell 多 `-c` 分段输出：

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "SELECT level, rule, count(*) AS cnt FROM ml.quality_reports GROUP BY level, rule ORDER BY level, rule;" -c "SELECT trade_date, level, rule, detail FROM ml.quality_reports WHERE level = 'critical' ORDER BY trade_date DESC LIMIT 20;"
```

## Table Structure (on demand)

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d ml.quality_reports"
```

## Pitfalls

- `detail` 为 jsonb；终端输出可能截断，必要时 `\x` 或只 SELECT 单字段。
- 按 `trade_date` 过滤可加速：`WHERE trade_date = '<YYYYMMDD>'`。
- `level` 受 CHECK 约束限制为 `info` / `warn` / `critical` 三者。
