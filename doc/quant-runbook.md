# 量化模型运维手册

> 本文档由 `TODO.md` 转化而来，作为量化模型训练模块的长期运维参考。
> 最后更新：2026-05-28

---

## 1. 环境配置

### 1.1 必需环境变量

| 变量 | 用途 | 配置方式 |
|------|------|----------|
| `TUSHARE_TOKEN` | TuShare Pro API token | `[Environment]::SetEnvironmentVariable("TUSHARE_TOKEN", "<token>", "User")` |
| `PG_DSN` | PostgreSQL 连接串 | `apps/quant-pipeline/.env` 中 `PG_DSN=postgresql+psycopg2://cryptouser:cryptopass@localhost:5432/cryptodb` |
| `QUANT_SSE_TOKEN_SECRET` | NestJS SSE 鉴权密钥 | `[Environment]::SetEnvironmentVariable("QUANT_SSE_TOKEN_SECRET", "<32字符随机串>", "User")` |

### 1.2 依赖安装

```powershell
pnpm install                          # Node.js 依赖
cd apps/quant-pipeline && uv sync     # Python 依赖（uv 管理）
```

---

## 2. 常用命令

### 2.1 数据同步

```powershell
# 同步指定日期范围的 raw 表
uv run quant sync raw --date-range 20240601:20240630 `
  --tables trade_cal,stk_limit,suspend_d,index_classify,index_member

# 同步当日数据（定时任务用）
uv run quant sync raw --date-range 20260528:20260528 `
  --tables daily,daily_basic,adj_factor,daily_indicator,stk_limit,suspend_d
```

### 2.2 因子计算

```powershell
# 计算指定版本因子
uv run quant factors compute --version v1 --date-range 20240601:20240630
```

### 2.3 质量检查

```powershell
# 严格模式质量检查
uv run quant quality check --date 20240628 --strict

# PIT 审计
uv run quant quality pit-audit

# 每日监控（IC 漂移 + 特征 PSI）
uv run quant quality monitor --model-version <model_version> --date 20260516
```

### 2.4 模型训练

```powershell
# Walk-Forward 训练
uv run quant train --feature-set <feature_set_id>

# Optuna 超参调优（50 trial，可中断恢复）
uv run quant tune --feature-set <feature_set_id> --n-trials 50

# Seed Averaging（5 seed 平均）
uv run quant seed-avg --base <base_model_version> --seeds 42,123,456,789,999
```

### 2.5 推理

```powershell
# 单日推理
uv run quant infer --date 20260516
```

---

## 3. 定时任务

### 3.1 注册 Windows 定时任务

```powershell
# 注册每日 22:00 执行的定时任务
pwsh -File scripts/quant-daily/register-task.ps1

# 自定义时间和任务名
pwsh -File scripts/quant-daily/register-task.ps1 -TaskName "MyQuantTask" -Time "23:00"

# 查看已注册任务
schtasks /Query /TN CryptoQuantDaily /V /FO LIST
```

### 3.2 每日执行流程

定时任务执行 `scripts/quant-daily/daily-sync-quality-infer.ps1`，三阶段严格顺序：

1. **Sync**: 同步当日 raw 数据（daily, daily_basic, adj_factor, daily_indicator, stk_limit, suspend_d）
2. **Quality**: 严格模式质量检查
3. **Infer**: 推理写入 `ml.scores_daily`

退出码语义：
- `0`: 全部成功
- `1`: sync 失败
- `2`: quality 阻断
- `3`: infer 失败
- `4`: 参数校验失败

### 3.3 DryRun 测试

```powershell
pwsh -File scripts/quant-daily/daily-sync-quality-infer.ps1 -DryRun
```

---

## 4. 数据库运维

### 4.1 常用查询

```sql
-- 查看模型训练记录
SELECT model_version, created_at, oos_metrics->'ndcg@10' AS ndcg10
FROM ml.model_runs
ORDER BY created_at DESC LIMIT 10;

-- 查看 Optuna 最佳试验
SELECT model_version, oos_metrics->'ndcg@10' AS ndcg10
FROM ml.model_runs
WHERE model_version LIKE 'optuna-best%'
ORDER BY created_at DESC LIMIT 5;

-- 查看 Seed Averaging 结果
SELECT model_version, oos_metrics->'ndcg@10' AS ndcg10
FROM ml.model_runs
WHERE model_version LIKE '%seedavg%'
ORDER BY created_at DESC LIMIT 5;

-- 查看每日评分行数对齐
SELECT trade_date,
       (SELECT count(*) FROM ml.scores_daily s WHERE s.trade_date = j.params->>'date') AS scored,
       (SELECT count(*) FROM raw.daily_quote q WHERE q.trade_date = j.params->>'date') AS raw_n,
       status, error_text
FROM ml.jobs j
WHERE run_type = 'infer' AND created_at > now() - interval '3 days'
ORDER BY created_at DESC;

-- 查看质量报告
SELECT level, rule, count(*)
FROM ml.quality_reports
GROUP BY level, rule
ORDER BY level, rule;

-- 30 天平均训练耗时
SELECT run_type,
       avg(EXTRACT(EPOCH FROM (finished_at - started_at))) AS avg_sec,
       max(EXTRACT(EPOCH FROM (finished_at - started_at))) AS max_sec,
       count(*) AS n
FROM ml.jobs
WHERE finished_at IS NOT NULL AND started_at IS NOT NULL
  AND created_at > now() - interval '30 day'
GROUP BY run_type
ORDER BY avg_sec DESC;
```

### 4.2 手动插入质量告警（测试用）

```sql
-- 模拟特征漂移触发 critical
INSERT INTO ml.quality_reports (trade_date, level, rule, detail)
VALUES ('20260517', 'critical', 'feature_drift_psi',
        '{"feature_id":"momentum_20d","psi":0.42,"bins":[]}'::jsonb);
```

---

## 5. 前端页面

| 路由 | 功能 |
|------|------|
| `/quant` | 总览：当日 Top-K + OOS 趋势 + Critical 告警 |
| `/quant/scores` | 评分：按日 ranked 列表 + 多模型对照 + 单股历史 |
| `/quant/runs` | 训练 Run 列表：分页 + OOS 指标徽章 |
| `/quant/runs/:id` | Run 详情：元数据/超参/Fold/SHAP/下载 |
| `/quant/jobs` | 作业队列：状态/SSE 进度条/触发训练 |
| `/quant/factors` | 因子清单：筛选/编辑/启用禁用 |

---

## 6. 风险预案

| 风险 | 预案 |
|------|------|
| TuShare 7000 积分单日耗尽 | fina_indicator 回填分批跑（按年）；其它每分钟限频 500-800 已在 `tushare_client.py` 内做了 |
| factors 回填中途崩溃 | 重跑会按 (trade_date, ts_code, factor_id, factor_version) PK 去重；继续即可 |
| GBDT vs 线性 NDCG@10 < 0.015 | 不通过 M3 验收，回到 M2 排查标签 5 个坑或 M1 加因子 |
| Walk-Forward 报 `min_train_days≥252` | 历史数据不足，回到 M1 扩大 `--date-range` 到 2018 |
| SSE 进度条不动 | 检查 `QUANT_SSE_TOKEN_SECRET` 已配；检查 Python worker 是否在跑；检查 `ml.jobs.heartbeat_at` 是否在更新 |
| Optuna 中断后不恢复 | 验证 `ml.studies / ml.trials` 表存在；同 study_name 再跑会 `load_if_exists=True` 续传 |

---

## 7. 扩容触发条件

满足任一条则需要从 Windows 单机迁到 Linux server：

| 触发指标 | 阈值 | 监测口径 |
|----------|------|----------|
| 因子数 | > 50 | `factors.feature_sets.factor_ids[]` 长度 |
| 单次 train（含 WF6 + 三组对照）耗时 | > 10 min | `ml.jobs.finished_at - started_at`（run_type='train'） |
| Optuna 50 trial 耗时 | > 4 小时 | 同上（run_type='optuna'） |
| SHAP 单次 | > 10 min | `ml.jobs.finished_at - started_at`（run_type 包含 shap_explainer 触发） |
| 内存 OOM | LightGBM 报错 / Booster.save_model fail | 日志 |

---

## 8. 参考文档

- Spec 入口：`doc/specs/2026-05-17-quant-model-training/00-index.md`
- 方法论：`doc/量化/00-index.md` ~ `10-术语表.md`
- 项目硬约束：`CLAUDE.md` + `.claude/rules/`
- Pipeline 工程文档：`apps/quant-pipeline/README.md`
- M4 容量复盘：`doc/m4-capacity-review.md`
