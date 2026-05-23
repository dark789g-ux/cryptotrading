# quant-pipeline · M0 骨架

A 股截面选股量化管道（Python · uv 管理）。本目录是 [doc/specs/2026-05-17-quant-model-training/](../../doc/specs/2026-05-17-quant-model-training/) 的代码侧落地。

## 现状（M0 → M1+）

- 落盘四个实装模块：`config` / `db` / `worker` / `cli`
- M1+ 各业务模块（`sync` / `factors` / `quality` / `labels` / `features` / `training` / `evaluation` / `inference`）已实装
- `ml.jobs` worker 链路打通：`run_type='noop'` 可被消费，写 `progress=100` + `status='success'` + `NOTIFY ml_job_progress`
- 重 ML 依赖（lightgbm / optuna / shap / pandas / tushare）已落 `pyproject.toml`

## CLI 入口（M1+）

```powershell
# TuShare → raw.* 同步（6 张 Python 侧拥有的表）
uv run quant sync raw --date-range 20240601:20240630 `
  --tables trade_cal,stk_limit,suspend_d,index_classify,index_member,fina_indicator

# 因子计算 → factors.daily_factors
uv run quant factors compute --version v1 --date-range 20240601:20240630

# 数据质量门禁（strict 模式下 critical → exit 1）
uv run quant quality check --date 20240628 --strict
uv run quant quality pit-audit

# 标签 / 特征矩阵 / 训练 / 推理
uv run quant labels build --scheme strategy-aware --date-range 20240601:20240630
uv run quant features build --factor-version v1 --label-scheme strategy-aware --date-range 20240601:20240630
uv run quant train  --feature-set fs_xxxxxxxx --model lgb-lambdarank
uv run quant infer  --model-version <model_version> --date 20240628

# 端到端训练（labels → features → train 三步串成单 job，spec 2026-05-23）
# TODO: CLI `quant train-e2e` 子命令暂未实装，目前仅通过 ml.jobs 入口触发
# （NestJS POST /api/quant/jobs body 含 run_type='train_e2e'）
uv run quant train-e2e --factor-version v1 --label-scheme strategy-aware `
  --new-listing-min-days 60 --date-range 20240601:20240630 --model lgb-lambdarank
```

`run_type='train_e2e'` 由 worker 顺序执行 labels → features → train，进度按
`0-30 / 30-60 / 60-100` 切片回写 ml.jobs.progress；成功后写 `result_payload`
含 `feature_set_id` + `model_version`，失败时 `error_text` 首行带
`[step:<labels|features|train|validate>]` 前缀（spec 04 §dispatcher 接线）。

## Windows uv 上手

> 前置：已安装 [uv](https://github.com/astral-sh/uv)，PowerShell 中 `where.exe uv` 能定位到 `uv.exe`。

```powershell
cd apps/quant-pipeline

# 1. 同步依赖（自动建 .venv 并解析锁文件）
uv sync

# 2. 准备环境变量
Copy-Item .env.example .env
# 编辑 .env，至少填好 PG_DSN

# 3. 冒烟：打印版本
uv run quant version

# 4. 单元测试（不触 DB，仅 NOTIFY payload schema）
uv run pytest tests/unit

# 5. 起 worker（需要 PG 已 up + factors/ml schema 已建）
uv run quant worker run
```

## 集成测试库

集成测试用一份独立的 PG 容器，端口避开生产的 `5432`（避免误操作生产数据）：

```powershell
cd apps/quant-pipeline
docker compose -f docker-compose.test.yml up -d
# 等待 healthy 后：
docker exec crypto-postgres-test psql -U cryptouser -d cryptodb_test -c "SELECT version();"

# Alembic 在测试库建 factors / ml schema（连接串覆盖 PG_DSN）
$env:PG_DSN = "postgresql+psycopg2://cryptouser:cryptopass@localhost:15432/cryptodb_test"
uv run alembic upgrade head
```

容器名 `crypto-postgres-test`、端口 `15432`，与 [doc/specs/2026-05-17-quant-model-training/04-error-quality-testing.md](../../doc/specs/2026-05-17-quant-model-training/04-error-quality-testing.md) §3 严格一致。

## Alembic（仅 factors / ml）

- `raw` schema 由 NestJS 侧手写 SQL 管理（[01-pg-schema.md §6](../doc/specs/2026-05-17-quant-model-training/01-pg-schema.md)）；本目录的 Alembic 不会触碰 `raw`
- `alembic_version` 表落在 `ml` schema 下（`version_table_schema='ml'`），避免污染 `public`
- 初始 migration：`src/quant_pipeline/db/migrations/versions/20260517_0001_factors_ml_initial.py`

```powershell
# 检查 migration 语法 / 元数据一致性（不写库）
uv run alembic check

# 离线模式生成 SQL（不连库）
uv run alembic upgrade head --sql

# 在线模式执行（确认 PG_DSN 后）
uv run alembic upgrade head
```

## M0 6 步发布序列

> 严格对齐 [01-pg-schema.md §6](../../doc/specs/2026-05-17-quant-model-training/01-pg-schema.md)。

1. **PG 创建三 schema**（生产库执行）：
   ```bash
   docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
     "CREATE SCHEMA IF NOT EXISTS raw; CREATE SCHEMA IF NOT EXISTS factors; CREATE SCHEMA IF NOT EXISTS ml;"
   ```
2. **打 git tag** `quant-migration-base`（指向迁移前的 main commit），作为回退锚点：
   ```powershell
   git tag quant-migration-base <commit-sha-before-entity-pr>
   git push origin quant-migration-base
   ```
3. **合入 NestJS entity PR**（5 张 a-share entity 改 schema='raw' + 去 `a_share_` 前缀），CI 通过，**但暂不部署**。该 PR 由 Part A agent 交付，具体 entity 路径见其交付物。
4. **执行手写正向 SQL**（生产 PG）：
   ```powershell
   # 直接走 PowerShell 包装脚本（含 ON_ERROR_STOP=1 + BEGIN/COMMIT）
   # 路径相对于仓库根
   powershell -File apps/server/migrations/apply-quant-raw-schema-migration.ps1
   # 或裸跑 SQL：
   docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 `
     < apps/server/migrations/20260517120000-quant-raw-schema-migration.sql
   ```
5. **部署新版 NestJS**（步骤 3 的 PR）；起服务后立刻跑一次既有 A 股同步任务，确认写 `raw.*` 成功。
6. **启动 Python worker**：
   ```powershell
   cd apps/quant-pipeline
   uv run quant worker run
   # 另一 PowerShell 验证消费链路：
   docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
     "INSERT INTO ml.jobs (run_type) VALUES ('noop') RETURNING id;"
   # 数秒后查 status：
   docker exec crypto-postgres psql -U cryptouser -d cryptodb -c \
     "SELECT id, status, progress, finished_at FROM ml.jobs ORDER BY created_at DESC LIMIT 1;"
   ```
   预期：`status='success'`、`progress=100`、`finished_at` 非空。

## M0 2 步回滚序列

> 步骤 5 部署完后若发现问题使用，**两步都要做**：

1. **DB 反向 SQL**（生产 PG）：
   ```powershell
   powershell -File apps/server/migrations/apply-quant-raw-schema-migration.down.ps1
   # 或裸跑 SQL：
   docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 `
     < apps/server/migrations/20260517120000-quant-raw-schema-migration.down.sql
   ```
2. **代码版本回退**：
   ```powershell
   git checkout quant-migration-base
   # 重新部署 NestJS（entity 回到 public.a_share_*）
   ```

只做第 1 步不做第 2 步 → NestJS 立即 500；只做第 2 步不做第 1 步 → NestJS 找不到表也 500。顺序固定为「DB 反向 → 代码回退部署」。

## 模块拆分（M1+ 占位）

```
src/quant_pipeline/
├─ cli.py             typer 主入口（M0：worker / version）
├─ config/            settings + 结构化日志
├─ db/                engine + Alembic migrations (factors / ml)
├─ worker/            poller + dispatcher + progress + loop（M0 实装）
├─ sync/              M1：TuShare → raw.*（仅 §5 划归 Python 的表）
├─ quality/           M2：八项校验 + PIT 审计 + 写 ml.quality_reports
├─ factors/           M1：因子库（量价 / 行业派生 / 财务）
├─ labels/            M2：strategy-aware + fwd_5d_ret 兜底
├─ strategy/          M2：exit_rules（出场规则）
├─ features/          M2：因子 → 矩阵
├─ training/          M2/M3/M4：LightGBM LambdaRank + WF + Optuna + SeedAvg
├─ evaluation/        M3/M4：ranking metrics + portfolio + SHAP + A/B
├─ inference/         M3：score_writer
└─ utils/             dates / paths
```

## 硬约束（与 CLAUDE.md 对齐）

- 源码 UTF-8；文件 I/O 显式 `encoding='utf-8'`
- 对象 / dict 键名用英文（避开 Windows GBK 终端下中文裸键名解析）
- 时间列一律 `timestamptz`；Alembic 中写 `sa.DateTime(timezone=True)`
- 同步任务失败必须显式 `failedItems`；`tushare_client.py` 三种空数据路径独立 warn（M1 实装时遵循 `worker.progress.warn_with_quality_report`）
- `# TODO: 查文档确认` 不允许出现在合入主干的代码
