# PG schema 总览 + 迁移策略

> 本文档是 [00-index.md](00-index.md) 的子文档。所有里程碑 agent 都需要本文档作为 schema / 通信契约的底座。

## 1 Schema 划分

| Schema | 用途 | 写者 | 读者 |
|---|---|---|---|
| `public` | NestJS 现有非 A 股业务 | NestJS | NestJS |
| `raw` | A 股原始数据 | NestJS (同步) | NestJS + Python |
| `factors` | 因子原值 / 标签 / 特征矩阵 (按版本) | Python | Python (+ Vue 通过 NestJS) |
| `ml` | jobs / model_runs / scores_daily / quality_reports | NestJS (jobs) + Python | NestJS / Vue / Python |

## 2 raw schema 表清单（M0 迁移范围）

| 旧表 (public) | 新表 (raw) | 说明 |
|---|---|---|
| `a_share_daily_quote` | `raw.daily_quote` | OHLCV 日线 |
| `a_share_daily_metric` | `raw.daily_basic` | PE/PB/换手等 |
| `a_share_adj_factor` | `raw.adj_factor` | 复权因子 |
| `a_share_daily_indicator` | `raw.daily_indicator` | 自算技术指标 |
| `a_share_indicator_calc_state` | `raw.indicator_calc_state` | 计算状态 |

**M1 起需新增同步的表**（Python 侧扩展 sync 模块）：
- `raw.stk_limit` 涨跌停价
- `raw.suspend_d` 停牌
- `raw.index_classify` / `raw.index_member` 行业分类与成份
- `raw.fina_indicator` 财务（必须以 `ann_date` 而非 `end_date` 入库）
- `raw.trade_cal` 交易日历

## 3 factors schema 表清单（M1 起建）

| 表 | 用途 | 主键 |
|---|---|---|
| `factors.daily_factors` | 长格式：(trade_date, ts_code, factor_id, factor_version, value) | PK(trade_date, ts_code, factor_id, factor_version) |
| `factors.labels` | (trade_date, ts_code, scheme, value, exit_reason, hold_days) | PK(trade_date, ts_code, scheme) |
| `factors.feature_sets` | 元数据：(feature_set_id, factor_version, scheme, factor_ids[], created_at) | PK(feature_set_id) |
| `factors.feature_matrix` | 宽格式训练矩阵（按 feature_set 分区） | PK(trade_date, ts_code, feature_set_id) |

按月分区（`PARTITION BY RANGE (trade_date)`）。

## 4 ml schema 表清单（M0 建空壳；M2 起填充）

```sql
ml.jobs (
  id                uuid PK,
  run_type          text NOT NULL,  -- noop|sync|quality|factors|labels|features|train|infer|optuna|seed_avg
  params            jsonb NOT NULL DEFAULT '{}'::jsonb, -- 各 run_type 的参数 schema 见 §4.1
  status            text NOT NULL DEFAULT 'pending',    -- pending|running|success|failed|blocked|cancelled
  progress          smallint NOT NULL DEFAULT 0,        -- 0..100；语义随 run_type 不同（见 §4.2）
  stage             text,                               -- 当前阶段名（与 NOTIFY 的 stage 字段一致）
  priority          smallint NOT NULL DEFAULT 100,      -- 数字小者先取，便于 reaper / 用户置顶
  attempts          smallint NOT NULL DEFAULT 0,
  max_attempts      smallint NOT NULL DEFAULT 1,        -- > 1 时允许 reaper 重试
  heartbeat_at      timestamptz,                        -- worker 每 30s 回写
  cancel_requested  boolean NOT NULL DEFAULT false,     -- NestJS 写 true，worker 读到后中止
  parent_job_id     uuid REFERENCES ml.jobs(id),        -- Optuna trial / seed_avg 单次 → 父 job
  log_url           text,                               -- POSIX 风格相对路径
  error_text        text,                               -- 失败 traceback 全量
  blocked_reason    text,                               -- 被数据质量门禁拦截时的规则名
  created_by        text,                               -- web 用户 id 或 'cron'
  created_at        timestamptz NOT NULL DEFAULT now(),
  started_at        timestamptz,
  finished_at       timestamptz
);
CREATE INDEX ON ml.jobs (status, priority, created_at);
CREATE INDEX ON ml.jobs (status, heartbeat_at) WHERE status = 'running';
CREATE INDEX ON ml.jobs (parent_job_id) WHERE parent_job_id IS NOT NULL;

ml.model_runs (
  id              uuid PK,
  job_id          uuid REFERENCES ml.jobs(id),
  model_version   text NOT NULL,  -- 'lgb-lambdarank-v1-20260620-seed42'
  feature_set_id  text NOT NULL,
  hyperparams     jsonb NOT NULL,
  oos_metrics     jsonb NOT NULL, -- {ndcg@5, ndcg@10, ic, rank_ic, portfolio_annual_after_cost, fold_metrics[]}
  artifact_uri    text NOT NULL,  -- './artifacts/<uuid>/model.txt'
  report_uri      text,           -- './artifacts/<uuid>/report.md'
  shap_uri        text,           -- M4 才写
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX ON ml.model_runs (model_version);

ml.scores_daily (
  trade_date      char(8) NOT NULL,        -- YYYYMMDD (A 股规范)
  ts_code         varchar(16) NOT NULL,
  model_version   text NOT NULL,
  score           double precision NOT NULL,
  rank_in_day     integer NOT NULL,        -- (PARTITION BY trade_date, model_version ORDER BY score DESC)
                                           -- 注意：避免使用 PG 关键字 `rank`（窗口函数同名）
  PRIMARY KEY (trade_date, ts_code, model_version)
);
CREATE INDEX ON ml.scores_daily (trade_date, model_version, rank_in_day);

ml.quality_reports (
  id              bigserial PK,
  trade_date      char(8) NOT NULL,
  level           text NOT NULL,    -- info|warn|critical
  rule            text NOT NULL,    -- 见 §4.3 规则名清单
  detail          jsonb NOT NULL,   -- 各 rule 的 detail schema 见 §4.3
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ml.quality_reports (trade_date, level);
```

### 4.1 `ml.jobs.params` 各 run_type 的最小 schema

| run_type | params 字段（必填 / 可选） | 进度语义（§4.2 参照） |
|---|---|---|
| `noop` | 无 | 直接 0 → 100 |
| `sync` | `date_range:"YYYYMMDD:YYYYMMDD"`, `tables:string[]` | 每张表完成 / 总表数 |
| `quality` | `date:"YYYYMMDD"`, `strict:bool` | 每条规则完成 / 总规则数 |
| `factors` | `version:string`, `date_range:string`, `factor_ids?:string[]` | 每日完成 / 总交易日数 |
| `labels` | `scheme:"strategy-aware"\|"fwd_5d_ret"`, `date_range:string` | 每日完成 / 总交易日数 |
| `features` | `factor_version:string`, `label_scheme:string` | 每日完成 / 总交易日数 |
| `train` | `feature_set_id:string`, `model:"lgb-lambdarank"\|"linear"\|"gbdt"`, `walk_forward:bool`, `seed?:int` | 每折完成 / 总 fold 数 |
| `infer` | `model_version:string`, `date:"YYYYMMDD"` | 每 N 支股票完成 / 总数 |
| `optuna` | `feature_set_id:string`, `n_trials:int`, `space:string` | 完成 trial 数 / `n_trials` |
| `seed_avg` | `model_version_base:string`, `seeds:int[]` | 完成 seed 数 / 总 seed 数 |

### 4.2 `progress` 字段统一约定

- `0` 表示尚未开始；`100` 表示完成（无论成功或失败，失败仍要写到 100）
- 推荐每完成一个最小工作单元写一次（fold / 表 / 交易日 / trial），但**最少**在 0 / 50 / 100 三档写
- 同时 `UPDATE ml.jobs` 与 `NOTIFY ml_job_progress` 两动作必须在同一事务内

### 4.3 `ml.quality_reports.rule` 清单与 `detail` schema

| rule | 触发时机 | detail 字段 |
|---|---|---|
| `<api_name>_empty` | TuShare 接口空数据（任一空路径） | `api_name`, `params`, `empty_path:"data_null"\|"items_empty"\|"code_nonzero"` |
| `row_count_drift` | 当日股票数与上一交易日差异 > 5% | `date`, `prev_count`, `curr_count`, `delta_ratio` |
| `pit_finance` | 财务因子用了 `end_date` 而非 `ann_date` | `factor_id`, `sample_ts_codes:string[]` |
| `adj_jump` | 复权因子单日跳变 > 阈值 | `ts_code`, `date`, `prev_factor`, `curr_factor`, `ratio` |
| `null_violation` | 行级硬约束被违反（OHLC 等列出现 NULL） | `table`, `column`, `violation_count`, `sample_keys` |
| `extreme_value` | 因子值超出 [μ-10σ, μ+10σ] | `factor_id`, `date`, `outlier_count` |
| `survivor_bias` | 历史日因子用到了未来才存在的股票 | `factor_id`, `date`, `count` |
| `feature_drift_psi` | M4 监控：当日特征 vs 训练分布 PSI > 0.25 | `feature_id`, `psi`, `bins` |
| `ic_drop` | M4 监控：滚动 20 日 IC < 上线时的 50% | `model_version`, `recent_ic`, `train_ic` |

## 5 raw 表所有权划分（NestJS sync vs Python sync）

为避免两套 sync 系统重复请求 TuShare、重复 upsert 同一组表，**职责严格划清**：

| Schema 表 | 拥有者 | 来源 / 现状 |
|---|---|---|
| `raw.daily_quote` | **NestJS** | 既有同步，M0 仅迁移 schema |
| `raw.daily_basic` | **NestJS** | 既有同步，M0 仅迁移 schema |
| `raw.adj_factor` | **NestJS** | 既有同步，M0 仅迁移 schema |
| `raw.daily_indicator` | **NestJS** | 既有同步，M0 仅迁移 schema |
| `raw.indicator_calc_state` | **NestJS** | 既有同步，M0 仅迁移 schema |
| `raw.stk_limit` | **Python (quant-pipeline)** | M1 新增 |
| `raw.suspend_d` | **Python (quant-pipeline)** | M1 新增 |
| `raw.index_classify` | **Python (quant-pipeline)** | M1 新增 |
| `raw.index_member` | **Python (quant-pipeline)** | M1 新增 |
| `raw.fina_indicator` | **Python (quant-pipeline)** | M1 新增（强制 ann_date PIT） |
| `raw.trade_cal` | **Python (quant-pipeline)** | M1 新增 |

约束：**同一张 raw 表只允许一个拥有者 upsert**，另一侧只读。这一划分要在 [02-quant-pipeline.md](02-quant-pipeline.md) `sync/` 的模块列表与 [m1-factor-library.md](m1-factor-library.md) deliverable 中显式呼应。

## 6 迁移执行序列（M0 必须严格按此顺序）

迁移由两件套构成：**DB 反向脚本** + **代码版本回退 tag**。任一缺失则迁移不可逆。

**正向部署**：
1. PG 创建 `raw / factors / ml` 三 schema（IF NOT EXISTS）。
2. **打 git tag** `quant-migration-base`（指向迁移前的 main commit），便于回退。
3. NestJS entity PR 合入 main，全部改 `@Entity({ schema: 'raw', name: 'daily_quote' })` 并去 `a_share_` 前缀；CI 通过；**但暂不部署**。
4. 在生产 PG 执行手写正向 SQL（含 docker exec 脚本），形如：
   ```sql
   ALTER TABLE public.a_share_daily_quote SET SCHEMA raw;
   ALTER TABLE raw.a_share_daily_quote RENAME TO daily_quote;
   -- ... 对每张表重复
   ```
5. 立即部署新版 NestJS（步骤 3 的 PR）；服务起来后跑一次既有 A 股同步任务，验证写 `raw.*` 成功。
6. `uv run quant worker run` 启动 Python worker，插入一条 `ml.jobs(run_type='noop')` 验证消费链路。

**回滚序列**（步骤 5 部署完后发现问题时使用，两步都要做）：
1. 在生产 PG 执行**反向 SQL**（必须随 migration 一起提供，形如）：
   ```sql
   ALTER TABLE raw.daily_quote RENAME TO a_share_daily_quote;
   ALTER TABLE raw.a_share_daily_quote SET SCHEMA public;
   -- ... 对每张表反向
   ```
2. `git checkout quant-migration-base` 并重新部署 NestJS（entity 回到 `public.a_share_*`）。

**只做第 1 步不做第 2 步会让 NestJS 立即 500**；只做第 2 步不做第 1 步会让 NestJS 找不到 `public.a_share_*` 也 500。两步顺序固定为"DB 反向 → 代码回退部署"。回滚脚本必须在测试库上完整演练通过才能合入。

**Synchronize / Migrations 约束**：本 module 与 CLAUDE.md 一致 —— TypeORM `synchronize: false`；本次迁移使用**手写** SQL migration，不走 TypeORM 自动迁移；factors / ml schema 内的 DDL 由 Python 侧 Alembic 管理（避免 NestJS / Python 抢同一份 DDL 责任）。
