# 场景：ml.jobs 状态

## Purpose

查看量化 worker 任务队列分布与最近 job 执行情况（pending / running / succeeded / failed 等）。

## Tables & Columns

- `ml.jobs` — `id`, `run_type`, `status`, `progress`, `stage`, `created_at`, `started_at`, `finished_at`, `error_text`

## Example SQL

按状态汇总：

```sql
SELECT status, count(*) AS cnt
FROM ml.jobs
GROUP BY status
ORDER BY cnt DESC;
```

最近 job：

```sql
SELECT id, run_type, status, progress, stage, created_at, started_at, finished_at
FROM ml.jobs
ORDER BY created_at DESC
LIMIT 5;
```

失败 job 详情：

```sql
SELECT id, run_type, status, error_text, created_at, finished_at
FROM ml.jobs
WHERE status IN ('failed', 'dead')
ORDER BY finished_at DESC NULLS LAST
LIMIT 10;
```

## Table Structure (on demand)

```powershell
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "\d ml.jobs"
```

## Pitfalls

- 列名为 `run_type`（非 `job_type`）；`status` 取值以 migration / worker 实现为准。
- `id` 为 UUID；SSE 进度流见前端 quant 模块文档。
- 长队列排查可加 `WHERE created_at > now() - interval '7 days'` 限制范围。
