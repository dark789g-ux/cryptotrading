# 量化模型训练模块 设计

- 日期：2026-05-17
- 状态：草稿，待审阅
- 涉及模块：新增 `quant-pipeline/`（仓库根目录，Python · uv 管理）、`apps/server/src/modules/quant/`、`apps/web/src/views/quant/`、PostgreSQL 新增 `raw / factors / ml` 三 schema
- 关联前作：`doc/量化/00-index.md` ~ `doc/量化/10-术语表.md`（10 篇方法论文档，本 spec 是其落地工程方案）

## 1 背景与目标

`doc/量化/` 下 10 篇文档已完整给出 A 股截面选股的方法论：标签设计（strategy-aware）、因子库分层（量价 + 行业派生 + 财务）、模型选型（LightGBM + LambdaRank）、评估方法（Purged Walk-Forward + 三组对照 + 扣成本年化）、部署监控（IC 漂移 + 特征 PSI）。但项目代码侧没有任何对应实现：

- 已有 A 股数据层（`a_share_daily_quote / a_share_daily_metric / a_share_adj_factor / a_share_daily_indicator`，由 NestJS+TypeORM 管理、TuShare 同步在跑），位于 `public` schema
- 已有加密择时 Python 子项目 `timing/`，方向不同，**不可复用**
- 已有 `BacktestRunner` 仅服务加密货币，与本 spec 的 "Purged Walk-Forward 离线评估" 是两件事
- 零量化训练相关代码、零 Python ML 工具链

本 spec 把上述方法论一次性映射为一份 90 天 Roadmap，切成 **M0 → M4** 5 个里程碑，每个里程碑独立可验收、可演示。

**非目标**：
- 本 spec 不设计 "A 股 daily 频回测引擎"（独立 spec 处理）
- 本 spec 不把模型评分接入实盘下单
- 本 spec 不涉及加密货币侧的任何改动

## 2 决策摘要（用户已确认）

| 决策项 | 决策 |
|---|---|
| Spec 范围 | 完整 90 天 Roadmap，一次写完 |
| 代码布局 | 同仓 · 根目录 `quant-pipeline/` · Python |
| Python 环境 | uv（pyproject.toml + uv.lock） |
| 与现有 A 股表的关系 | 迁移进 `raw` schema（去 `a_share_` 前缀）+ NestJS entity 同步改 |
| 运行位置与触发 | 本地 Windows + CLI 手动 + Windows 任务计划 |
| 前端可见性 | 读展示（评分看板）+ 训练 run 管理 UI（含 SHAP / 触发） |
| NestJS ↔ Python 通信 | PG 作业队列表 `ml.jobs`，NestJS 插行、Python worker 轮询 |
| 阶段切分形态 | 5 个里程碑 M0 → M4 |
| Roadmap 内是否含监控 | 是，M4 含 IC 漂移 + 特征 PSI 监控 |
| e2e UI 测试形态 | 手测打卡（不引 Playwright） |
| 训练 / 推理设备 | 本机 CPU，不预设云方案；M4 复盘时判断是否需扩容 |
| 因子库初始规模 | M1 约 30 维（量价 20 + 行业派生 10） |

## 3 架构总览

```
┌─────────────────────────────────────────────────────────────┐
│  cryptotrading/ (monorepo)                                  │
│                                                             │
│  apps/server (NestJS)                                       │
│    ├ a-share 现有同步：entity 切到 raw.*                    │
│    ├ 新增 modules/quant/：                                  │
│    │   · jobs controller (POST/GET /quant/jobs/*)           │
│    │   · scores / runs / quality 只读 controller            │
│    │   · SSE 进度推送（PG LISTEN/NOTIFY 桥接）              │
│    └ 写 ml.jobs(pending) 行作为唯一触发手段                 │
│                                                             │
│  apps/web (Vue)                                             │
│    └ 新增 views/quant/：                                    │
│        · /quant            Overview (Top-K + 模型版本)      │
│        · /quant/scores     按日 ranked 列表                 │
│        · /quant/runs       训练 run 列表                    │
│        · /quant/runs/:id   超参 / fold / SHAP / 下载        │
│        · /quant/jobs       作业队列                         │
│        · QuantTrainTriggerModal (复用 AppModal)             │
│                                                             │
│  quant-pipeline/ (Python · uv 管理) ※本仓新建               │
│    ├ pyproject.toml + uv.lock                               │
│    ├ src/quant_pipeline/                                    │
│    │   ├ cli.py             typer 主入口                    │
│    │   ├ sync/        TuShare → raw.*                       │
│    │   ├ quality/     PIT 审计 + 8 项数据质量门禁           │
│    │   ├ factors/     raw → factors.daily_factors           │
│    │   ├ labels/      strategy-aware → factors.labels       │
│    │   ├ features/    因子 + 标签 → 训练矩阵                │
│    │   ├ strategy/    exit_rules.py (训练/回测共用)         │
│    │   ├ training/    LightGBM LambdaRank + Walk-Forward    │
│    │   ├ evaluation/  NDCG / IC / Portfolio / SHAP / A-B    │
│    │   ├ inference/   写 ml.scores_daily                    │
│    │   └ worker/      轮询 ml.jobs                          │
│    ├ tests/{unit,integration,contract}                      │
│    └ artifacts/{model_run_id}/  本地 model.txt / report.md  │
│                                                             │
│  PG (single instance · 4 schemas)                           │
│    ├ public.*      NestJS 现有非 A 股业务                   │
│    ├ raw.*         A 股原始 (从 public.a_share_* 迁移)      │
│    ├ factors.*     因子 / 标签 / 特征 (按 factor_version)   │
│    └ ml.*          jobs / model_runs / scores_daily /       │
│                    quality_reports                          │
└─────────────────────────────────────────────────────────────┘
```

**通信契约（关键）**：NestJS 与 Python **不通过 HTTP 互调**，全部通过 PG 通信：
- NestJS 写 `ml.jobs(status='pending')` → Python worker `SELECT FOR UPDATE SKIP LOCKED` 取行执行
- Python 写 `ml.scores_daily` / `ml.model_runs` / `ml.quality_reports` → NestJS 读
- Python 进度推送通过 `NOTIFY ml_job_progress, '<json>'` → NestJS SSE 转发到前端

**重启 / 崩溃行为定义**：
- **Worker 崩溃保护**：Python worker 每 30 秒回写 `ml.jobs.heartbeat_at`。NestJS 侧（或 Python 自带）一个 reaper 每 60 秒扫 `status='running' AND heartbeat_at < now() - interval '3 min'` 的行，把它们 `status` 重置为 `pending` 并 `attempts += 1`；超过 `max_attempts` 则 `status='failed'` + `error_text='heartbeat_timeout'`
- **SSE 重连回补**：NestJS SSE endpoint 在建立连接时**先 SELECT 一次** `ml.jobs.progress` 当前值推给客户端（避免 LISTEN 之前的进度被错过）；之后 LISTEN 增量
- **NOTIFY payload schema**：固定 `{"job_id":"<uuid>","progress":<int 0..100>,"stage":"<str>"}`，**总长 ≤ 1KB**（远低于 PG 8KB 上限），不允许携带日志正文、错误堆栈或 SHAP 数组
- **NestJS SSE 桥接进程**必须维持一条**独立、长生命周期**的 PG 连接专门 `LISTEN`，不与请求池复用；断线重连后立即重新 `LISTEN`

## 4 PG schema 总览 + 迁移策略

### 4.1 Schema 划分

| Schema | 用途 | 写者 | 读者 |
|---|---|---|---|
| `public` | NestJS 现有非 A 股业务 | NestJS | NestJS |
| `raw` | A 股原始数据 | NestJS (同步) | NestJS + Python |
| `factors` | 因子原值 / 标签 / 特征矩阵 (按版本) | Python | Python (+ Vue 通过 NestJS) |
| `ml` | jobs / model_runs / scores_daily / quality_reports | NestJS (jobs) + Python | NestJS / Vue / Python |

### 4.2 raw schema 表清单（M0 迁移范围）

| 旧表 (public) | 新表 (raw) | 说明 |
|---|---|---|
| `a_share_daily_quote` | `raw.daily_quote` | OHLCV 日线 |
| `a_share_daily_metric` | `raw.daily_basic` | PE/PB/换手等 |
| `a_share_adj_factor` | `raw.adj_factor` | 复权因子 |
| `a_share_daily_indicator` | `raw.daily_indicator` | 自算技术指标 |
| `a_share_indicator_calc_state` | `raw.indicator_calc_state` | 计算状态 |

**M1 起需新增同步的表**（NestJS 侧扩展 sync 模块）：
- `raw.stk_limit` 涨跌停价
- `raw.suspend_d` 停牌
- `raw.index_classify` / `raw.index_member` 行业分类与成份
- `raw.fina_indicator` 财务（必须以 `ann_date` 而非 `end_date` 入库）
- `raw.trade_cal` 交易日历

### 4.3 factors schema 表清单（M1 起建）

| 表 | 用途 | 主键 |
|---|---|---|
| `factors.daily_factors` | 长格式：(trade_date, ts_code, factor_id, factor_version, value) | PK(trade_date, ts_code, factor_id, factor_version) |
| `factors.labels` | (trade_date, ts_code, scheme, value, exit_reason, hold_days) | PK(trade_date, ts_code, scheme) |
| `factors.feature_sets` | 元数据：(feature_set_id, factor_version, scheme, factor_ids[], created_at) | PK(feature_set_id) |
| `factors.feature_matrix` | 宽格式训练矩阵（按 feature_set 分区） | PK(trade_date, ts_code, feature_set_id) |

按月分区（`PARTITION BY RANGE (trade_date)`）。

### 4.4 ml schema 表清单（M0 建空壳；M2 起填充）

```sql
ml.jobs (
  id                uuid PK,
  run_type          text NOT NULL,  -- noop|sync|quality|factors|labels|features|train|infer|optuna|seed_avg
  params            jsonb NOT NULL DEFAULT '{}'::jsonb, -- 各 run_type 的参数 schema 见 §4.4.1
  status            text NOT NULL DEFAULT 'pending',    -- pending|running|success|failed|blocked|cancelled
  progress          smallint NOT NULL DEFAULT 0,        -- 0..100；语义随 run_type 不同（见 §4.4.2）
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
  rule            text NOT NULL,    -- 见 §4.4.3 规则名清单
  detail          jsonb NOT NULL,   -- 各 rule 的 detail schema 见 §4.4.3
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX ON ml.quality_reports (trade_date, level);
```

### 4.4.1 `ml.jobs.params` 各 run_type 的最小 schema

| run_type | params 字段（必填 / 可选） | 进度语义（§4.4.2 参照） |
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

### 4.4.2 `progress` 字段统一约定

- `0` 表示尚未开始；`100` 表示完成（无论成功或失败，失败仍要写到 100）
- 推荐每完成一个最小工作单元写一次（fold / 表 / 交易日 / trial），但**最少**在 0 / 50 / 100 三档写
- 同时 `UPDATE ml.jobs` 与 `NOTIFY ml_job_progress` 两动作必须在同一事务内

### 4.4.3 `ml.quality_reports.rule` 清单与 `detail` schema

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

### 4.5 raw 表所有权划分（NestJS sync vs Python sync）

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

约束：**同一张 raw 表只允许一个拥有者 upsert**，另一侧只读。这一划分要在 §5 `quant-pipeline/sync/` 的模块列表与 §8.2 M1 deliverable 中显式呼应。

### 4.6 迁移执行序列（M0 必须严格按此顺序）

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

**Synchronize / Migrations 约束**：本 module 与 CLAUDE.md 一致 —— TypeORM `synchronize: false`；本次迁移使用**手写**SQL migration，不走 TypeORM 自动迁移；factors / ml schema 内的 DDL 由 Python 侧 Alembic 管理（避免 NestJS / Python 抢同一份 DDL 责任）。

## 5 quant-pipeline 模块拆分

```
quant-pipeline/
├─ pyproject.toml          uv 管理；依赖见下
├─ uv.lock
├─ README.md               中文 · UTF-8 · Windows uv 上手步骤
├─ .env.example            PG_DSN / TUSHARE_TOKEN / ARTIFACT_DIR / LOG_DIR
├─ alembic.ini             仅管理 factors / ml schema
├─ src/quant_pipeline/
│   ├─ __init__.py
│   ├─ cli.py              typer 主入口
│   ├─ config/
│   │   ├─ settings.py     Pydantic settings
│   │   └─ logging.py      JSON 结构化日志 (UTC; 含 job_id 上下文)
│   ├─ db/
│   │   ├─ engine.py       SQLAlchemy engine 单例 + 连接池
│   │   ├─ schemas.py      raw / factors / ml ORM
│   │   └─ migrations/     Alembic (仅 factors / ml)
│   ├─ sync/               TuShare → raw.* (仅 §4.5 划归 Python 的表)
│   │   ├─ tushare_client.py   含限频 + retry + 三种空数据 warn
│   │   ├─ stk_limit.py / suspend.py / index_classify.py /
│   │   │   index_member.py / fina_indicator.py / trade_cal.py
│   │   └─ orchestrator.py     不动 daily / daily_basic / adj_factor / daily_indicator（NestJS 拥有）
│   ├─ quality/
│   │   ├─ checks.py       doc/03 八项校验
│   │   ├─ pit_audit.py    doc/03 三铁律自动审计
│   │   └─ report.py       写 ml.quality_reports
│   ├─ factors/
│   │   ├─ base.py         Factor 抽象类 + PIT 窗口声明 API
│   │   ├─ price/          动量 / 波动率 / 成交量
│   │   ├─ fundamental/    财务 (强制 ann_date PIT)
│   │   ├─ industry/       doc/07 行业派生 + 中性化
│   │   ├─ registry.py     factor_id × factor_version 注册表
│   │   └─ runner.py       compute(date_range) → factors.daily_factors
│   ├─ labels/
│   │   ├─ strategy_aware.py   doc/04 推荐方案
│   │   ├─ fallback.py         fwd_5d_ret 兜底
│   │   └─ runner.py
│   ├─ strategy/
│   │   └─ exit_rules.py   MA5 出场 / -8% 止损 / max_hold 20
│   │                      ※必须可被未来 A 股回测引擎导入
│   ├─ features/           因子 → 矩阵；中性化 / 标准化 / 分桶 / 交互
│   ├─ training/
│   │   ├─ lightgbm_lambdarank.py   doc/05 标准配置 + 单调性约束
│   │   ├─ walk_forward.py          Purged + embargo ≥ 21 日
│   │   ├─ tuning.py                Optuna 4 主旋钮 (M4)
│   │   ├─ seed_averaging.py        (M4)
│   │   └─ runner.py
│   ├─ evaluation/
│   │   ├─ ranking_metrics.py   NDCG@K / IC / RankIC
│   │   ├─ portfolio.py         扣成本 (佣金 + 滑点) 年化
│   │   ├─ shap_explainer.py    (M4)
│   │   └─ ab_compare.py        三组对照
│   ├─ inference/
│   │   ├─ score_writer.py      写 ml.scores_daily
│   │   └─ runner.py            进入 score_writer 之前必须先调用 quality.checks
│   │                           的"推理前必检"（§9.2），失败则不写
│   ├─ worker/
│   │   ├─ poller.py            FOR UPDATE SKIP LOCKED
│   │   ├─ dispatcher.py        run_type → runner 映射
│   │   └─ progress.py          回写 progress / NOTIFY
│   └─ utils/
│       ├─ dates.py             A 股交易日历访问器
│       └─ paths.py             POSIX 风格 artifact 路径
└─ tests/
    ├─ unit/                    每 factor 一个单测 (PIT / 极值 / 缺失)
    ├─ integration/             docker-postgres 起一次性测试库
    └─ contract/                TuShare 接口字段冻结回归
```

**依赖清单（pyproject.toml）**：
- 数据：`pandas`、`polars`、`numpy`、`pyarrow`
- DB：`sqlalchemy[psycopg2]`、`alembic`
- 模型：`lightgbm`、`scikit-learn`（仅 baseline / preprocessing）
- 调参 / 解释：`optuna`、`shap`
- TuShare：`tushare`
- CLI / 配置：`typer`、`pydantic-settings`
- 测试 / Lint：`pytest`、`pytest-cov`、`ruff`、`mypy`

**与 CLAUDE.md 第三方 API 规范对齐**：`tushare_client.py` 对三种空数据情形（`data=None` / `items=[]` / `code≠0`）必须分路径 `logger.warn(api_name, params)` 并把 `<api_name>_empty` 写 `ml.quality_reports`；禁止 `try: ... except: pass` 静默吞错。

## 6 CLI 表面

```bash
# 数据
uv run quant sync raw --date-range 20240101:20260517 --tables daily,daily_basic,adj_factor
uv run quant quality check --date 20260516 --strict

# 因子 / 标签 / 特征
uv run quant factors compute --version v1 --date-range 20200101:20260517
uv run quant labels build   --scheme strategy-aware --date-range 20200101:20260517
uv run quant features build --factor-version v1 --label-scheme strategy-aware

# 训练 / 评估 / 推理
uv run quant train    --feature-set fs_v1 --model lgb-lambdarank --walk-forward
uv run quant evaluate --run-id <uuid> --ab-baseline linear,gbdt
uv run quant infer    --run-id <uuid> --date 20260517

# 调度
uv run quant worker run   # 常驻，轮询 ml.jobs
```

**CLI 与 worker 的关系**：CLI 是无状态调用入口（给人 / 任务计划 / NestJS 子进程用）；worker 把"一次调用"包装成 `ml.jobs` 行驱动。两者最终进入同一组 runner，逻辑只有一份。

**门禁不可绕过**：CLI 不提供 `--force` 旗标。任何 quality 失败导致的 `status=blocked` 只能通过修代码或修数据解除。

**Worker / Runner 进度写入约定**（与 §4.4.2 一致）：
- runner 在每个最小工作单元完成后调用 `worker.progress.update(job_id, pct, stage)`，该方法**在同一事务内** `UPDATE ml.jobs SET progress=, stage=, heartbeat_at=now()` + `NOTIFY ml_job_progress, '{"job_id","progress","stage"}'`
- heartbeat：worker dispatcher 在没有进度变化时也每 30 秒单独刷一次 `heartbeat_at`（不发 NOTIFY）
- 取消响应：runner 每个工作单元开始前 `SELECT cancel_requested FROM ml.jobs WHERE id=...`；若为 true 立即抛 `JobCancelled`，dispatcher 捕获后写 `status='cancelled'`

## 7 NestJS / Vue 改动表面

### 7.1 NestJS：`apps/server/src/modules/quant/`

```
modules/quant/
├─ quant.module.ts
├─ entities/
│   ├─ ml-job.entity.ts           @Entity({ schema: 'ml', name: 'jobs' })
│   ├─ ml-model-run.entity.ts     @Entity({ schema: 'ml', name: 'model_runs' })
│   ├─ ml-score-daily.entity.ts   @Entity({ schema: 'ml', name: 'scores_daily' })
│   └─ ml-quality-report.entity.ts
├─ dto/
│   ├─ create-job.dto.ts          run_type + params (class-validator)
│   ├─ score-query.dto.ts         trade_date / model_version / top_k
│   └─ run-query.dto.ts           pagination / model_version filter
├─ services/
│   ├─ quant-jobs.service.ts      insert job · query status · cancel
│   ├─ quant-scores.service.ts    scores_daily 只读
│   ├─ quant-runs.service.ts      model_runs 只读 + OOS metrics
│   └─ quant-quality.service.ts   quality_reports 只读
├─ controllers/
│   ├─ quant-jobs.controller.ts       POST /quant/jobs · GET /quant/jobs · GET /quant/jobs/:id
│   ├─ quant-scores.controller.ts     GET /quant/scores
│   ├─ quant-runs.controller.ts       GET /quant/runs · GET /quant/runs/:id
│   └─ quant-quality.controller.ts    GET /quant/quality/:date
└─ realtime/
    └─ quant-jobs.sse.ts          Server-Sent Events: 订阅 job 进度
```

**NestJS 规范遵循**（来自 CLAUDE.md）：
- `AuthGuard` 已全局注册，本 module controller **禁止**再加 `@UseGuards(AuthGuard)`
- 时间列一律 `timestamptz`；`scores_daily.trade_date` 用 `char(8)` 与 A 股规范一致
- `synchronize: false`；本 module 引入新表也走手写 SQL migration（与 §4.6 同批）
- 动态 SQL 构建禁止把前端字段名拼入：scores / runs 的 filter / sort 必须经过 `FIELD_COL_MAP` 翻译，未命中 `logger.warn` + skip

**进度推送方案**：
- Python worker 在更新 `ml.jobs.progress` 后立即 `NOTIFY ml_job_progress, '<§3 通信契约里的 payload>'`
- NestJS `quant-jobs.sse.ts` 用一个常驻 PG 连接 `LISTEN ml_job_progress`，把 NOTIFY payload 转发给当前订阅的 SSE 客户端
- SSE 建立连接的瞬间**先 SELECT 一次**当前 `ml.jobs.progress` 推给客户端（避免 LISTEN 之前的进度被错过；§3）
- 不引入 WebSocket / 不引入消息队列，零额外组件

**SSE 鉴权方案**：浏览器原生 `EventSource` 不带 `Authorization` header，所以 `quant-jobs.sse.ts` 不能依赖全局 `AuthGuard`。方案：客户端先调 `POST /quant/jobs/:id/sse-token` 拿一个 5 分钟有效的短期 token（继承当前用户会话），再用 `EventSource('/quant/jobs/:id/stream?token=...')` 建连；SSE controller 单独的 `@SseTokenGuard` 校验该 token，不挂全局 `AuthGuard`。这是 CLAUDE.md "AuthGuard 全局注册" 的合法例外，需在 controller 上明确注释说明。

### 7.2 Vue：`apps/web/src/views/quant/`

```
views/quant/
├─ QuantOverviewView.vue       /quant         总览
├─ QuantScoresView.vue         /quant/scores  按日 ranked 列表
├─ QuantRunsView.vue           /quant/runs    训练 run 列表
├─ QuantRunDetailView.vue      /quant/runs/:id  含 SHAP / 下载 model.txt
├─ QuantJobsView.vue           /quant/jobs    作业队列
├─ QuantTrainTriggerModal.vue  触发训练弹窗 (复用 AppModal)
└─ components/
    ├─ ScoreTable.vue
    ├─ MetricBadge.vue
    ├─ ProgressLine.vue        订阅 SSE
    └─ ShapBarChart.vue
```

**Vue 规范遵循**（来自 CLAUDE.md）：
- Modal 统一复用 `AppModal`；按钮放 `#actions` slot，子组件不自带按钮
- 任何"切换回来需重拉数据"的逻辑放 `onActivated`，不放 `onMounted`（keep-alive 陷阱）
- 自定义 select option 接口 `extends SelectOption`，不重新声明 `label/value`
- 单文件 ≤ 500 行；`QuantRunDetailView` 必须拆 4-6 个子组件
- 日期选择器值（本地 ms）用 `getFullYear/getMonth/getDate` 提取，禁止 `getUTCxxx`

**Router**：`/quant` 加入 router 表，菜单一项「量化」。

## 8 5 个里程碑：deliverable & acceptance

> 每个里程碑都有：**目标 / 交付物 / 验收门槛（可机器或人工核对）/ 估时**。
> 验收门槛不达不进入下一里程碑。

### 8.1 M0 · 数据迁移与 schema 底座（1-1.5 周）

**目标**：把 A 股表迁进 `raw`，建出 `factors / ml` 空壳，所有上下游可以基于新 schema 工作。

**交付物**：
1. 手写 SQL migration（含 docker exec 脚本 + 反向脚本）覆盖 §4.6 全部 6 步正向序列 + 2 步回滚序列；git tag `quant-migration-base`
2. NestJS 既有 a-share entity 全部改指向 `raw.*` 并去 `a_share_` 前缀；构建 & 单测通过
3. `quant-pipeline/` uv 项目骨架：`pyproject.toml` + 空 `cli.py` + `db.engine` 能连上 PG
4. `factors / ml` schema 下各表的 Alembic 初始 migration（空表 + 索引）
5. `ml.jobs` 表 + 最小 worker（`run_type='noop'` 能拿行并回写 `status='success'`）

**验收门槛**：
- `pnpm --filter @cryptotrading/server build` 通过；既有 A 股同步任务一次跑完无报错
- `uv run quant worker run` 启动；插入 `ml.jobs(run_type='noop')` 一行能被消费、`status` 变 `success`、`finished_at` 写入
- 回滚脚本在测试库上验证通过（手测：执行回滚后 NestJS 重新跑通既有同步）
- §4.6 中的"6 步发布序列 + 2 步回滚序列"作为 M0 README 一节落盘

### 8.2 M1 · 因子库 v1 + PIT 检测（2 周）

**目标**：产出 doc/07 MVP 约 30 维因子（量价 20 + 行业派生 10），通过 PIT 审计。

**交付物**：
1. `factors/base.py` 抽象类，含 PIT 窗口声明 API
2. 30 个因子实现 + 每个一份单测（PIT 窗口 / 极值 / 缺失 / 复权）
3. `factors.daily_factors`（按 `factor_version` 分区）写入完成，覆盖 2018 至今
4. 数据质量门禁 doc/03 八项 + 落 `ml.quality_reports`
5. PIT 自动审计（doc/03 三铁律 + 三幽灵 Bug 检测）作为独立 `quant quality pit-audit` 命令
6. **Python 侧** `quant-pipeline/sync/` 新增 `raw.stk_limit / raw.suspend_d / raw.index_classify / raw.index_member / raw.fina_indicator / raw.trade_cal` 6 张表的同步实现（§4.5 所有权划分）；NestJS sync 不动既有 5 张表，但 entity / repo 要能只读新 6 张表

**验收门槛**：
- 每个因子的 PIT 单测全绿
- 历史日（如 2024-06-30）抽 5 个因子人工核对值（与 TuShare 原始数据 / 公开行情对照）
- 行级硬约束：所有非 NULL 因子在合规交易日 100% 非空（doc/03 最弱可接受标准）
- 跨表对齐：`count(factors.daily_factors WHERE trade_date=X) >= count(raw.daily_quote WHERE trade_date=X)`
- `fina_indicator` 必须以 `ann_date` 而非 `end_date` 入库（PIT 铁律）

### 8.3 M2 · 标签 + LightGBM 训练 MVP 通路 + ml.jobs 骨架（3 周，可延 1 周）

**目标**：从 `ml.jobs` 触发 → `model.txt` 落盘 → `ml.scores_daily` 写入的 end-to-end 跑通。**不追求模型质量、不接前端**。

**交付物**：
1. `strategy/exit_rules.py`：MA5 出场 / -8% 止损 / max_hold 20 实现，**作为可被未来 A 股回测引擎导入的独立模块**
2. `labels/strategy_aware.py` 调用 `exit_rules` 产生 doc/04 推荐方案标签，含 5 个坑全处理（涨跌停 / 停牌 / 新股 / 退市 / 强右偏）
3. `features/` 把因子 + 标签拼成训练矩阵（含中性化 / 标准化）
4. LightGBM LambdaRank 训练（doc/05 标准配置，**先单 fold**，先不接 Walk-Forward）
5. artifact 落到本地 `./artifacts/{model_run_id}/model.txt` + `meta.json`
6. inference 写 `ml.scores_daily`（含 `model_version`，且**进入 score_writer 前必跑推理前必检**，§9.2）
7. NestJS `modules/quant/` 仅上 **jobs controller**（POST/GET /quant/jobs/*）+ SSE token endpoint；scores / runs / quality 三只读 controller **不在 M2**（移至 M3 与 UI 一并）
8. Python worker dispatcher 覆盖 `train` / `infer` 两个 `run_type`，含 §4.4.2 进度写入 + heartbeat + cancel 响应
9. 训练前自动跑 quality 门禁；失败 → `ml.jobs.status='blocked'` + `blocked_reason`

**估时弹性**：M2 是整个 Roadmap 风险最高的一段（标签 5 坑 / PIT 实证 / 训练首次跑通）。若实际超过 3 周，允许延至 4 周；总 Roadmap 90 天有 5-10 天弹性可吸收（M0+M1+M2+M3+M4 = 12-13.5 周内）。

**验收门槛**：
- 一次 `POST /quant/jobs { run_type:"train", params:{...} }` → `ml.model_runs` 出现一行 → `ml.scores_daily` 当日**所有出现在 `raw.daily_quote` 的股票均有评分**（行数严格相等，不允许少 1 行；多则报错）
- OOS NDCG@10 > 随机基线（≥ 0.01 即可，不需要好）
- `model.txt` 可被 LightGBM CLI 独立加载预测（验证 artifact 不依赖 Python pickle）
- `exit_rules.py` 有独立单测，覆盖 4 种出场路径（MA5 / 止损 / max_hold / 强制平仓）
- 数据质量被人为破坏（删一行因子）后 train job 必须 `blocked` 而非 `success`
- worker 模拟崩溃（kill -9）后，reaper 在 3 分钟内把 `status='running'` 行回收为 `pending`（§3 重启行为）

### 8.4 M3 · Walk-Forward 评估 + 三组对照 + 前端评分看板（3-3.5 周）

**目标**：把"能跑"变成"可信"，且产出第一个可看的 UI。

**交付物**：
1. Purged Walk-Forward（embargo ≥ 21 日）正式接入 `training/runner.py`
2. 三组对照实验：**线性 baseline / GBDT 单模 / 集成**，OOS 指标三栏并排写 `ml.model_runs.oos_metrics`
3. 评估扣成本：佣金 + 滑点的 portfolio 年化（doc/05）
4. 自动报告生成：`./artifacts/{model_run_id}/report.md`，含三组对照表 + 每折指标
5. NestJS `modules/quant/`：**新增 scores / runs / quality 三只读 controller + 对应 service**（从 M2 移入），含 FIELD_COL_MAP 字段映射（CLAUDE.md 动态 SQL 规范）
6. Vue：`/quant` Overview + `/quant/scores` + `/quant/runs` 三页 + 共享组件（ScoreTable / MetricBadge）
7. 模型版本切换器（query string + URL 同步）

**验收门槛**：
- 三组对照实验报告自动生成且可下载
- GBDT vs 线性 OOS NDCG@10 **绝对值提升 ≥ 0.015**（例如 0.500 → ≥ 0.515；非相对 3%）；不达不能进 M4，需排查标签 / 因子
- Walk-Forward fold ≥ 6 折，每折 IC / NDCG / 扣成本年化均有记录
- 前端三页手测主流程无 5xx；列表分页、模型版本切换、Top-K 调整均工作
- 同一交易日 `ml.scores_daily` 两个 `model_version` 共存查询无串扰
- scores 查询接口在 5500 标的 × 4 年历史规模下 P95 < 500ms（PG 索引验收）

### 8.5 M4 · 训练 run UI + SHAP + Optuna + Seed Averaging + 监控（3 周）

**目标**：可运营 / 可解释 / 可监控。

**交付物**：
1. `QuantRunDetailView`：超参 / fold 表 / SHAP top-20 柱状图 / `model.txt` 下载
2. `QuantJobsView` + `QuantTrainTriggerModal`（弹窗触发训练 / 触发 Optuna / 触发 Seed Averaging）
3. SSE 进度推送 + PG `LISTEN ml_job_progress` 通道 + SSE token 鉴权（§7.1）
4. Optuna 调参（doc/05 四个主旋钮：`num_leaves` / `min_data_in_leaf` / `feature_fraction` / `learning_rate`）作为独立 `run_type='optuna'`；**必须使用 Optuna PG RDB storage**（不允许 in-memory），使中断可恢复
5. Seed Averaging（5 seed 平均）作为 `run_type='seed_avg'`，每个 seed 一个 child job（`parent_job_id` 指向父）
6. 监控：**每日推理后**自动算 IC / 评分分布 / 与上次的特征漂移 PSI，超阈值落 `ml.quality_reports(level=warn|critical)`，规则名见 §4.4.3 (`feature_drift_psi` / `ic_drop`)
7. cron / Windows 任务计划脚本模板：**每日 22:00 触发** `sync → quality → infer` 链（避开 18:00 当日数据尚未全发布的窗口；各表最早可用时点见 §8.6 附录）
8. 复盘报告：本机 CPU 跑当前规模因子 / 模型 / 调参的时延实测；判断是否需扩容（仅给结论，不做实现）
9. Vue 单文件 ≤ 500 行的 CI 校验脚本（pre-commit hook 或 lint rule），所有 `views/quant/**` 文件强制走

**验收门槛**：
- 在 web 上点"触发训练" → 进度条实时滚动（< 2 秒延迟，且 SSE 重连后能立即拿到当前 progress；§3）→ 完成后 RunDetail 显示 SHAP
- Optuna 一次完整调参（≥ 50 trial）能跑完且 best_trial 落 `ml.model_runs`；中途 kill Python 进程后重启，trial 进度可从断点恢复
- 模拟一次特征漂移（人为篡改输入分布）→ `ml.quality_reports` 产生 `critical` 行 → 前端 Overview 顶部告警条
- 任务计划脚本在本地连续运行 3 个交易日无人值守；定义"成功"为：每日 22:30 前 `ml.scores_daily` 当日股票数 = `raw.daily_quote` 当日股票数；定义"失败"为：任意一天有 `ml.jobs.status='failed'` 或 `'blocked'` 且未人工介入
- 单文件 ≤ 500 行 CI 校验通过；`QuantRunDetailView` 拆分后所有子文件均 ≤ 500 行

### 8.6 附录：A 股 raw 表当日最早可用时点（M4 任务计划依赖）

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

## 9 错误处理 / 数据质量门禁

### 9.1 错误处理总则
- **同步任务失败必须显式在响应体 `errors[]` / `failedItems[]` 中透出**（CLAUDE.md 既立硬规矩）。Python `sync` 模块对应：`tushare_client` 三种空数据情形（`data=None` / `items=[]` / `code≠0`）必须**分路径** `logger.warn(api_name, params)` 并把 `<api_name>_empty` 写 `ml.quality_reports`
- **Python worker 任何未捕获异常必须把 traceback 全量写到 `ml.jobs.error_text`** 并把 `status='failed'`；禁止 `except: pass`；禁止 `try / except / log / continue` 静默吞错
- **NestJS controller 报 500**：开 TypeORM `logging:['error','warn']` + `logger.error(err.stack)`，禁止静态分析猜
- **PG 作业队列并发安全**：worker 取 job 用 `SELECT ... FROM ml.jobs WHERE status='pending' ORDER BY created_at FOR UPDATE SKIP LOCKED LIMIT 1`
- **artifact 写盘失败处理**：`./artifacts/{model_run_id}/` 写不进去 → job `failed` + 清理半成品目录；不允许 `model.txt` 落库但 metrics 没写完的半态

### 9.2 数据质量门禁（最致命，独立成节）
- **训练前必检**（M2 起强制）：当日因子表行级硬约束 + 跨表对齐 + PIT 三铁律全绿才允许进 `training/runner.py`；否则 job 直接 `status='blocked'` + `blocked_reason='<rule_name>'`
- **推理前必检**（M2 起强制）：当日 `raw.daily_quote` 完整（行级 OHLC 非空 + 与上一交易日股票数差 < 5%）才允许 `inference`；否则 `ml.scores_daily` 不允许写入当日（避免半量评分误导前端）
- **5% 阈值的边界**：节假日前后 / 科创板批量上市当周 / 大规模摘牌期 5% 易误杀。允许通过 `params.row_count_drift_threshold` 在调用方按交易日维度临时放宽到 10%，但需在 `ml.quality_reports` 记一条 `level='info'` 的"阈值临时放宽"事件留痕
- **门禁不可被 `--force` 绕过**——CLI 不提供该旗标；要绕只能改代码（被代码评审拦截）
- **CLAUDE.md "fetcher 返回 0 行必须显式 failedItems" 同样适用**：sync 模块的 fetcher 返回空必须 push 到响应体 `failedItems`（`api_name` 标 `daily_empty` / `adj_factor_empty` / 等），让前端 / 日志立即可见
- **Python 侧 `logger.warn` 双写**：CLAUDE.md 原文以 NestJS 为语境。Python `tushare_client` 与各 runner 在记录 warn 时，**同时**做两件事：(1) 结构化 JSON 日志（含 `job_id` 上下文）；(2) `INSERT INTO ml.quality_reports`（rule + detail）。两者缺一不可——日志方便实时排查，DB 行让前端 quality 看板可见。

## 10 测试策略

| 层级 | 范围 | 工具 |
|---|---|---|
| 单元 | 每个 factor / label / 工具函数 | pytest + pytest-cov（阈值 80%） |
| 契约 | TuShare 接口字段、PG schema | pytest + 真实小样本回归（人工对照后冻结） |
| 集成 | sync → factors → labels → train → infer 全链路 | pytest + docker-postgres 一次性测试库 |
| NestJS | controller + service | Jest（项目已有约定） |
| 端到端 UI | quant 三视图主流程 | **手测打卡**（不引 Playwright；不要求自动化） |

**单测红线**：
- 因子 / sync 单测使用 mock 数据时，必须同时存在一份"小样本真实数据"集成测试（避免 CLAUDE.md 的 "mock 单测不验证第三方契约" 陷阱）
- `# TODO: 查文档确认` 的接口调用不得视为完成，含此注释的代码不允许合入主干

**集成测试库管理**：本地用 `docker compose -f docker-compose.test.yml` 起一个固定容器名 `crypto-postgres-test`，端口 `15432`（避开生产 `5432`）；pytest fixture `db_session` 在每次 session 起前 `DROP SCHEMA raw, factors, ml CASCADE` 再用 Alembic / 手写 migration 重建，保证隔离。

**Vue 单文件 ≤ 500 行 CI 校验**（M4 交付物 9）：在 `apps/web` 加一份 pre-commit hook 或 lint rule，扫描 `views/quant/**` 与 `components/quant/**` 下 `.vue` 文件总行数，超 500 直接 fail。校验脚本作为该 M4 交付物的一部分被 review。

## 11 风险与开放议题

1. **Roadmap 90 天压在本地 Windows 单机能否跑动**
   LightGBM CPU 训练对 5500 支 × 6 年 × 30 因子 × Walk-Forward 6 fold 是分钟级，可接受；Optuna 50 trial 是数小时级，过夜可。若后续因子膨胀到 100+，需考虑迁到 Linux server。**M4 复盘报告里给出"是否需要扩容"的判断**，本 spec 不预设云方案。

2. **strategy-aware labeling 与未来 A 股回测引擎的对齐风险**（已纳入 M2 显式交付物）
   labeling 模拟的出场规则（MA5 / -8% 止损 / max_hold 20）必须与未来 A 股回测引擎用同一份代码。**M2 实现时把 `strategy/exit_rules.py` 抽出为可被回测引擎 `import` 的独立模块**，并在该模块顶部用注释明确声明此约束。

3. **A 股 daily 频回测引擎当前不存在**
   现有 `BacktestRunner` 仅服务加密。若未来要把模型评分接入"A 股模拟盘"，需另起一份 "A 股 daily 回测引擎" spec。**本 spec 明确不包含此项**。

4. **数据迁移期 NestJS 与 Python 的发布顺序**
   必须 NestJS entity 切到 `raw` 之后立即跑 migration，再启动 Python sync。中间窗口内既有 NestJS 同步会失败。**M0 验收要求附 "6 步发布序列 + 2 步回滚序列" 作为 README 一节**（§4.6 已给出原型，含 git tag `quant-migration-base`）。

5. **TuShare 7000 积分对 P1 财务接口的覆盖度需验证**
   doc/06 说够用，但 `fina_indicator` / `disclosure_date` 等接口的实际权限要在 M1 首次拉数据时确认。若不足需触发"是否升级积分"议题，**不在本 spec 范围内决策**。

6. **Windows 路径分隔符在 artifact_uri / log_url 上的跨平台陷阱**
   全程用 POSIX 风格存库（`./artifacts/<uuid>/model.txt`），不存盘符；前端下载链接由 NestJS 拼当前主机 base URL。Python 侧用 `pathlib.PurePosixPath` 序列化。

7. **PG LISTEN/NOTIFY 跨进程注意事项**（已在 §3 通信契约中定义具体行为）
   独立长连接 / 重连后重新 LISTEN / 订阅者断开清理 / NOTIFY payload ≤ 1KB。

8. **Worker 崩溃与 reaper 死锁**
   reaper 把 `status='running'` 行回收为 `pending` 是基于 `heartbeat_at` 超时，但如果**所有** worker 都崩溃同时无人启动 reaper，job 永远不会被回收。reaper 必须在 Python worker 启动时**先跑一次**（覆盖上一次崩溃留下的 orphan），并在常驻轮询里每 60 秒跑一次。**reaper 与 worker 同进程同生命周期**，避免出现"reaper 在跑但 worker 全死"的诡异态。

9. **Optuna RDB storage 的 schema 占用**
   Optuna 用 PG RDB storage 时会在指定 schema 下建一组自带表（`studies`、`trials`、`trial_values` 等）。spec 决策：放在 `ml` schema 下（前缀 `optuna_*`），与 `ml.jobs` 并列；不放 `factors` / `raw`。Alembic migration 不管理 Optuna 自建表，由 Optuna 库自己 `optuna.create_study(..., storage=..., load_if_exists=True)` 触发。

## 12 参考文档索引

- `doc/量化/00-index.md` 全局索引
- `doc/量化/01-训练体系蓝图.md` 6 阶段框架
- `doc/量化/02-数据分层与PG-schema.md` raw/factors/ml 三层 schema 设计 ← 本 spec §4 的方法论来源
- `doc/量化/03-PIT与数据质量.md` 三铁律 + 三幽灵 Bug ← §9.2 来源
- `doc/量化/04-标签设计.md` strategy-aware labeling ← M2 来源
- `doc/量化/05-LightGBM训练体系.md` 标准配置 + Walk-Forward + Optuna ← M2/M3/M4 来源
- `doc/量化/06-TuShare接口清单.md` P0/P1/P2 接口与积分门槛
- `doc/量化/07-行业板块因子.md` 行业派生因子 + 中性化 ← M1 来源
- `doc/量化/08-反模式集合.md` 6 层禁忌清单 ← §9 / §10 的红线来源
- `doc/量化/09-Roadmap-经验-项目结构.md` 90 天路线图与代码结构建议 ← 本 spec 整体来源
- `CLAUDE.md` 项目硬约束（编码 / NestJS 规范 / Vue 规范 / 时间规范 / 第三方 API 规范）← §4.6 / §7 / §9 的合规来源
