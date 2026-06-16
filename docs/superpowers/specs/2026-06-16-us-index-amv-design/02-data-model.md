# 02 · 数据模型（两张新表 + run_type CHECK）

> 所有 schema 变更走 `apps/server/migrations/*.sql` + 同名 `.ps1`（`.claude/rules/database-sql.md`），
> 实体 TypeORM 双注册（module forFeature + `app.module.ts` 根 `entities[]`）。
> DDL 列类型均已落真 DB `\d` 核验（见 [index 锚点核验](./index.md)）。

## 1. `raw.us_index_amv_daily`（AMV 输出表）

镜像 `public.industry_amv_daily`（真 DB `\d` 核验），把 `ts_code` → `index_code`，schema 放 `raw`
（与 `raw.us_index_daily` 等 `us_*` 表一致；A 股 `industry_amv_daily`/`oamv_daily` 在 `public`，
us 系列全在 `raw`）。

```sql
CREATE TABLE IF NOT EXISTS raw.us_index_amv_daily (
  id           bigserial PRIMARY KEY,
  index_code   character varying(16) NOT NULL,
  trade_date   character varying(8)  NOT NULL,
  amv_open     double precision,
  amv_high     double precision,
  amv_low      double precision,
  amv_close    double precision,
  amv_dif      double precision,
  amv_dea      double precision,
  amv_macd     double precision,
  amv_zdf      double precision,
  signal       smallint NOT NULL,
  member_count integer,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_index_amv_daily UNIQUE (index_code, trade_date),
  CONSTRAINT ck_us_index_amv_daily_signal CHECK (signal IN (-1, 0, 1))
);
CREATE INDEX IF NOT EXISTS ix_us_index_amv_daily_code_date
  ON raw.us_index_amv_daily (index_code, trade_date DESC);
CREATE INDEX IF NOT EXISTS ix_us_index_amv_daily_date_signal
  ON raw.us_index_amv_daily (trade_date, signal);
```

- 列语义与 `industry_amv_daily` 完全一致：四价 + MACD 三列 + `amv_zdf`（涨跌幅，可空）+
  `signal`（-1/0/1，NOT NULL）+ `member_count`（当日有效成分数）。
- `amv_*` 双精度可空（schema 容错；**异常日整行丢弃不落库**，故实际落库行的 `amv_close` 恒非空，
  见 [03 异常处置](./03-amv-formula.md#异常处置)）。

## 2. `raw.us_index_constituent`（成分名单表）

```sql
CREATE TABLE IF NOT EXISTS raw.us_index_constituent (
  id          bigserial PRIMARY KEY,
  index_code  character varying(16) NOT NULL,
  ticker      character varying(16) NOT NULL,
  weight_pct  double precision,            -- 仅 top-25 有值，余 NULL（裸Σ不用，仅参考）
  name        character varying,
  updated_at  timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT uq_us_index_constituent UNIQUE (index_code, ticker)
);
CREATE INDEX IF NOT EXISTS ix_us_index_constituent_code
  ON raw.us_index_constituent (index_code);
```

- seed 101 只 `.NDX` 成分（Wikipedia 全集），`weight_pct` 用 stockanalysis 可匹配的 25 只，余 NULL。
- 成分 ticker **不**写入 `raw.us_symbol`（无外键，见 [04 §1 取数](./04-python-pipeline.md#1-成分股取数不污染策划清单)）。

## 3. run_type CHECK 约束加 `us_index_amv_sync`（三处镜像，缺一即 POST 派 job 撞约束 500）

新增 run_type 必须**同时**改三处（`reference_run_type_check_constraint` 教训）：

### 3.1 Python alembic（权威）

新建 `apps/quant-pipeline/src/quant_pipeline/db/migrations/versions/20260616_0002_add_us_index_amv_sync_run_type.py`：
- `revision="20260616_0002"`，`down_revision="20260616_0001"`（接**文件链 head**；`alembic heads`=20260616_0001、
  链无分叉，已 `alembic heads/current` 实跑核验）。
- `upgrade()`：`DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check` → `ADD CONSTRAINT ... CHECK` 含
  现 15 值超集 **+ `'us_index_amv_sync'`**（共 16 值）。
- `downgrade()`：回到现 15 值。
- 镜像现有 `20260616_0001_add_us_sync_us_index_sync_run_types.py` 的 `_RUN_TYPES_*` 常量写法。

现 15 值（真 DB `pg_get_constraintdef` 核验）：
```text
'noop','sync','quality','factors','labels','features','train','infer','optuna',
'seed_avg','train_e2e','prepare','kelly_sweep','us_sync','us_index_sync'
```

### 3.2 NestJS SQL 镜像

新建 `apps/server/migrations/20260616150000-us-index-amv-run-type-check.sql` + 同名 `.ps1`，
照 `20260616140000-us-index-run-type-check.sql/.ps1`：`DROP IF EXISTS` + `ADD CONSTRAINT`
含 16 值（现 15 + `us_index_amv_sync`），`.ps1` 用
`Get-Content -Raw -Encoding utf8 <sql> | docker exec -i crypto-postgres psql -U cryptouser -d cryptodb -v ON_ERROR_STOP=1 -f -`
+ 校验段查 `pg_get_constraintdef`。

### 3.3 TS 类型 + DTO 白名单

- [ml-job.entity.ts:37-53](apps/server/src/entities/ml/ml-job.entity.ts:37) `MlJobRunType` 联合末尾加
  `| 'us_index_amv_sync'`。
- [create-job.dto.ts:60-78](apps/server/src/modules/quant/dto/create-job.dto.ts:60) `ALLOWED_RUN_TYPES`
  末尾加 `'us_index_amv_sync'`。
- `us_index_amv_sync` **不**进 `LABEL_REF_RUN_TYPES` / `FEATURE_SET_RUN_TYPES`（与 `us_index_sync` 同档，
  `create()` 直接 save 无附加校验）。

## 4. 迁移执行与顺序（alembic 当前脱节，已实跑核验）

**真实状态（`alembic current` / `alembic heads` + `SELECT version_num FROM alembic_version` 三方核验）：**
- 文件链 head = `20260616_0001`；但真 DB `alembic_version` = **`20260614_0001`**（落后一格）。
- `20260616_0001`（add_us_sync/us_index_sync run_types）**尚未经 alembic apply**；当前 DB 的 CHECK 已含
  `us_sync/us_index_sync` 这 15 值，是被 NestJS 侧 `20260616140000-us-index-run-type-check.sql` **带外
  （docker exec）补进去的**，alembic 版本号未随之推进。这正是 `project_alembic_drift` 教训。

**执行（T1）：**
1. 先 `uv run alembic current` 核对真实版本号（预期 `20260614_0001`）+ `uv run alembic upgrade head --sql` 审 DDL。
2. `uv run alembic upgrade head`：会从 `20260614_0001` **连跑 `0001` + `0002` 两步**。`0001` 与 `0002` 都是
   幂等 `DROP CONSTRAINT IF EXISTS` + `ADD CONSTRAINT`，重放 `0001` 的 CHECK（DDL 效果 DB 已有）**安全**，
   **无需 stamp**。
3. upgrade 后 `alembic current` 应推进到 `20260616_0002`、`pg_get_constraintdef` 含 16 值（含 `us_index_amv_sync`）。
- NestJS SQL：跑 `.ps1`（docker exec）。两侧约束 DDL 必须字面一致（16 值超集）。
- 实体双注册：见 [05 §5 实体双注册](./05-nestjs-and-api.md#5-实体双注册)。
