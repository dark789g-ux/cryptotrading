# quant-daily：每日 22:00 sync → quality → infer 链

> 配套 spec：
> - `doc/specs/2026-05-17-quant-model-training/m4-monitoring-frontend-v2.md`（交付物 #7、§附录 raw 表可用时点、验收门槛）
> - `doc/specs/2026-05-17-quant-model-training/03-nestjs-vue.md` §1（进度推送方案：NestJS 已切 PG LISTEN/NOTIFY，本脚本仅负责触发 Python CLI）
> - `CLAUDE.md`（Shell 规范：禁用 `&&`；第三方 API 集成规范：fetcher 返回 0 行必须 failedItems；数据集完整性最弱可接受标准）

## 文件清单

| 文件 | 用途 |
|---|---|
| `daily-sync-quality-infer.ps1` | 真正干活的脚本：22:00 触发，按顺序跑 sync → quality → infer，任一步失败即 exit 非 0 |
| `register-task.ps1` | 把 `daily-sync-quality-infer.ps1` 注册为 Windows 任务计划用户级触发器，无需管理员权限 |
| `README.md` | 本文件，含 raw 表当日最早可用时点附录原文 + 22:00 选择论证 + 3 日无人值守验收清单 |

## 1. 注册任务

```powershell
# 项目仓库根目录执行
pwsh -File scripts\quant-daily\register-task.ps1
# 或自定义时间 / 任务名
pwsh -File scripts\quant-daily\register-task.ps1 -Time 22:30 -TaskName CryptoQuantDaily
```

注销：

```powershell
schtasks /Delete /TN CryptoQuantDaily /F
```

查询 / 手动触发一次（用于验收）：

```powershell
schtasks /Query /TN CryptoQuantDaily /V /FO LIST
schtasks /Run   /TN CryptoQuantDaily
```

## 2. 手动跑（不通过任务计划）

```powershell
# 默认 = 今日（按本机时区 Asia/Shanghai）
pwsh -File scripts\quant-daily\daily-sync-quality-infer.ps1

# 补跑历史日期
pwsh -File scripts\quant-daily\daily-sync-quality-infer.ps1 -TradeDate 20260515

# 干跑：只打印命令、不执行
pwsh -File scripts\quant-daily\daily-sync-quality-infer.ps1 -DryRun
```

退出码语义（任务计划「上次运行结果」会显示十进制 ExitCode）：

| ExitCode | 含义 |
|---|---|
| 0 | sync + quality + infer 三步全成功 |
| 1 | sync raw 失败（TuShare 报错 / 网络 / 积分不足） |
| 2 | quality check 阻断（critical 级数据质量门槛未过；不可推理） |
| 3 | infer 失败 |
| 4 | 参数 / 环境校验失败（脚本一开始就退） |

## 3. 22:00 触发时刻的论证（m4-monitoring-frontend-v2.md §附录原文）

> 实际经验值，M1 首次同步时需在 ml.quality_reports 中观察并修正。

| 表 | 最早可用 | 备注 |
|---|---|---|
| `raw.daily_quote` | T 日 17:30 | 个别股票延后到 18:30 |
| `raw.daily_basic` | T 日 18:00 | PE/PB 等需收盘价计算 |
| `raw.adj_factor` | T 日 18:30-20:00 | 不稳定，建议 21:00 后拉 |
| `raw.daily_indicator` | T 日 20:00 后 | 项目自算，依赖前 3 项 |
| `raw.stk_limit` | T 日 17:00 | 收盘即固定 |
| `raw.suspend_d` | T 日 17:00 | 交易所公告口径 |
| `raw.fina_indicator` | 公告日，盘前/盘后均可能 | 强制以 `ann_date` 入库 |

**结论**：cron 触发时刻 ≥ 21:00，推荐 **22:00**（给 adj_factor 留 1 小时缓冲）。若需更早，可在 T+1 早 09:00 跑（更稳但延迟一天）。

### 为什么不是 18:00

- `adj_factor` 在 18:30-20:00 之间陆续返回，18:00 触发会拿到部分股票缺 adj_factor 的不完整快照
- `raw.daily_indicator` 本项目自算，依赖 daily_quote / daily_basic / adj_factor 三者齐全；其依赖未稳定就触发推理会产出错误评分
- 18:00 触发若失败重跑，重跑时间往往在 20:00 之后，相比直接 22:00 一次性成功并未节省运维时间

### 22:30 是否更稳

- 若 M4 上线后 `ml.quality_reports` 多次出现 22:00 触发但 adj_factor 残缺的记录，可改用 `register-task.ps1 -Time 22:30`
- 任务计划「成功」要求 22:30 前 `ml.scores_daily` 已全量写完；若改到 22:30 触发会留给 infer 阶段过窄的时间窗（infer 自身常耗 5-10 分钟），需要先在 M4 实测后决策

## 4. 3 日无人值守验收清单（M4 验收门槛）

m4-monitoring-frontend-v2.md 验收门槛原文：

> 任务计划脚本在本地连续运行 3 个交易日无人值守；定义"成功"为：每日 22:30 前 `ml.scores_daily` 当日股票数 = `raw.daily_quote` 当日股票数；定义"失败"为：任意一天有 `ml.jobs.status='failed'` 或 `'blocked'` 且未人工介入。

### 手动验收 SQL（每日 22:35 跑一次，3 日连续观察）

```bash
# D1（举例 20260518）：覆盖率检查
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
WITH s AS (SELECT COUNT(DISTINCT ts_code) AS n_scores
           FROM ml.scores_daily WHERE trade_date = '20260518'),
     r AS (SELECT COUNT(DISTINCT ts_code) AS n_raw
           FROM raw.daily_quote WHERE trade_date = '20260518')
SELECT s.n_scores, r.n_raw,
       CASE WHEN s.n_scores = r.n_raw THEN 'PASS' ELSE 'FAIL' END AS verdict
FROM s, r;
"

# D1 失败态检查：任意 failed / blocked 都视为不达标
docker exec crypto-postgres psql -U cryptouser -d cryptodb -c "
SELECT id, run_type, status, blocked_reason, error_text, created_at
FROM ml.jobs
WHERE created_at::date = '2026-05-18'
  AND status IN ('failed','blocked')
ORDER BY created_at DESC;
"
```

| 验收日 | 覆盖率 SQL 结果 | failed/blocked 检查 | 结论 |
|---|---|---|---|
| D1 | n_scores == n_raw | 0 行 | PASS |
| D2 | n_scores == n_raw | 0 行 | PASS |
| D3 | n_scores == n_raw | 0 行 | PASS |
| 任意一日 | 不等 OR 出现 failed/blocked 且未人工介入 | — | FAIL |

3 日全 PASS = M4 任务计划交付物达标。

## 5. 与 NestJS SSE 的关系

任务计划是「触发器」，进度反馈走 PG LISTEN/NOTIFY：

```
┌─────────────────┐    schtasks 22:00      ┌────────────────────────────────────┐
│ Windows 任务计划 │ ─────────────────────> │ daily-sync-quality-infer.ps1       │
└─────────────────┘                        │   uv run quant sync ...            │
                                           │   uv run quant quality check ...   │
                                           │   uv run quant infer ...           │
                                           └──────────────┬─────────────────────┘
                                                          │  写 ml.jobs + NOTIFY ml_job_progress
                                                          ▼
                                           ┌────────────────────────────────────┐
                                           │ NestJS PgListenService              │
                                           │   独立长连接 LISTEN ml_job_progress │
                                           │   ↓                                 │
                                           │ QuantJobsSseController              │
                                           │   /quant/jobs/:id/stream            │
                                           └─────────────────┬───────────────────┘
                                                             ▼
                                                        浏览器 Vue 进度条
```

本脚本不直接对 NestJS 发请求；只要 Python CLI 的 worker 写 `ml.jobs` + `pg_notify` 就够了。
