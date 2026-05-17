# quant-pipeline Python 子项目 · 模块拆分与 CLI

> 本文档是 [00-index.md](00-index.md) 的子文档。M1 起所有里程碑 agent 都需要本文档。

## 1 目录结构

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
│   ├─ sync/               TuShare → raw.* (仅 01-pg-schema §5 划归 Python 的表)
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
│   │                           的"推理前必检"（04-error-quality-testing.md），失败则不写
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

## 2 依赖清单（pyproject.toml）

- 数据：`pandas`、`polars`、`numpy`、`pyarrow`
- DB：`sqlalchemy[psycopg2]`、`alembic`
- 模型：`lightgbm`、`scikit-learn`（仅 baseline / preprocessing）
- 调参 / 解释：`optuna`、`shap`
- TuShare：`tushare`
- CLI / 配置：`typer`、`pydantic-settings`
- 测试 / Lint：`pytest`、`pytest-cov`、`ruff`、`mypy`

**与 CLAUDE.md 第三方 API 规范对齐**：`tushare_client.py` 对三种空数据情形（`data=None` / `items=[]` / `code≠0`）必须分路径 `logger.warn(api_name, params)` 并把 `<api_name>_empty` 写 `ml.quality_reports`；禁止 `try: ... except: pass` 静默吞错。

## 3 CLI 表面

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

## 4 Worker / Runner 进度写入约定

（与 [01-pg-schema.md](01-pg-schema.md) §4.2 一致）

- runner 在每个最小工作单元完成后调用 `worker.progress.update(job_id, pct, stage)`，该方法**在同一事务内** `UPDATE ml.jobs SET progress=, stage=, heartbeat_at=now()` + `NOTIFY ml_job_progress, '{"job_id","progress","stage"}'`
- heartbeat：worker dispatcher 在没有进度变化时也每 30 秒单独刷一次 `heartbeat_at`（不发 NOTIFY）
- 取消响应：runner 每个工作单元开始前 `SELECT cancel_requested FROM ml.jobs WHERE id=...`；若为 true 立即抛 `JobCancelled`，dispatcher 捕获后写 `status='cancelled'`
- reaper：worker 启动时**先跑一次**回收上一次崩溃留下的 orphan `running` 行；之后在常驻轮询里每 60 秒跑一次。reaper 与 worker 同进程同生命周期（详见 [05-risks.md](05-risks.md) 第 8 项）
