# 02 · 数据模型与迁移

> **表结构权威文档**见 [doc/db/index.md](../../../doc/db/index.md)。本文档保留设计 rationale；**DDL 已迁移至 doc/db/**。

← 返回 [index.md](./index.md)

## ml.jobs 复用约定（不新增列）

复用现有 `ml.jobs` 表，不加列。两个 jsonb 列承载本任务数据：

- **`params`**（输入）：装 `SweepConfig` 12 字段 + `exit_families`。形如：
  ```json
  {
    "base_trigger": {"field": "kdj_j", "op": "lt", "value": 0.0},
    "universe": "all",
    "max_window": 20, "max_entry_filters": 1, "min_samples": 300,
    "train_range": ["20230101", "20241231"],
    "valid_range": ["20250101", "20260608"],
    "bootstrap_iters": 1000, "same_day_rule": "sl_first",
    "rs_benchmark": ["hs300", "zz500"], "rs_lookback": 5, "top_k": 30,
    "exit_families": ["fixed_n", "tp_sl", "trailing", "atr_stop"]
  }
  ```
  > `base_trigger`/`train_range`/`valid_range` 的结构与 `SweepConfig`（`config.py:23-110`）逐字对齐；`exit_families` 是本任务新增（不属 SweepConfig，runner 用它过滤 `DEFAULT_EXIT_GRID`，见 [03](./03-python-runner.md#familiesexit_grid-构造函数防口径漂移)）。
- **`result_payload`**（输出摘要，扫完写）：装轻量摘要供列表/历史下拉快速展示，不重复全表：
  ```json
  {
    "n_rows": 848, "n_topk": 60, "n_frontier": 14,
    // n_topk = top_k × 已扫分组数(with_rs/no_rs)；n_frontier = 两组前沿点合计
    "best": {"window_group": "with_rs", "variant_id": "...", "exit_id": "fixed_n(n=1)",
             "kelly_valid": 0.383, "kelly_ci_low": 0.343, "kelly_ci_high": 0.424, "n_valid": 3004}
  }
  ```

## 结果表

全量 `ResultRow`（一轮约 848 行，`max_entry_filters=2` 时可达 6000+）落独立 `research` schema 专表。表结构：`research.kelly_sweep_results`（列定义按需 `\d schema.table`）

字段与 `ResultRow`（`sweep.py:135-212`，已核对）一一对应。

### ResultRow → 表字段映射要点

- **不落 `valid_keys`**（`sweep.py:202`，每行可能上千个 (ts_code,signal_date) 对）：CI 已由 `rank_top_k` 算好存进 `kelly_ci_low/high`，前端逐行详情无需重算，省大量空间。
- `variant_filters`（`list[tuple[str,str,float]]`）→ `jsonb` 数组的数组。
- `exit_cfg`（`dict`）→ `jsonb` 原样存。
- `is_frontier` 来自 `compute_pareto_frontier(rows)` 返回的 `is_frontier`（`report.py:36-90`）；`is_topk` 来自 `rank_top_k`（`report.py:98-142`）入选集合。runner 落库前把这两个布尔合并标到行上。
- Kelly/胜率/盈亏比等 `Optional[float]` → 可空 `DOUBLE PRECISION`（NULL 合法，不进非空硬约束）。
- `n_train`/`n_valid`/`below_floor`/`same_day_rule`/`window_group`/`variant_id`/`exit_id` 业务上必非空 → `NOT NULL`。

### 一张表三种查询全覆盖

| 前端需求 | 查询 |
|---|---|
| 帕累托散点 | `WHERE job_id=? AND window_group=?` 取全行，画 (n_valid, kelly_valid)，`is_frontier` 高亮连线，`below_floor` 灰点 |
| top-K 排行 | `WHERE job_id=? AND window_group=? AND is_topk` `ORDER BY kelly_valid DESC` 分页 |
| 全量浏览 | `WHERE job_id=? AND window_group=?` 分页 + 任意列排序 |
| 逐行详情 | `WHERE id=?` 单行 |

## Migration（两个动作，alembic 单文件）

Python worker 是写入方，结果表用 **alembic 建表**；NestJS 只读映射（entity 见 [04](./04-nestjs-api.md#typeorm-entity-双注册)）。一个 alembic revision 完成两件事：

### 动作 1：`ml_jobs_run_type_check` 加入 `'kelly_sweep'`

**这是历史踩坑点**：新增 run_type 漏更新此 CHECK → INSERT 撞约束 → TypeORM 未捕获 → HTTP 500 且无 job 落库（prepare/train_e2e 均栽过，见 `20260606_0004_add_prepare_run_type.py`）。沿用其 DROP+重建模式（幂等、单一真相源、新约束是旧约束真超集）：

```python
# upgrade: DROP IF EXISTS + 重建, 在最新枚举基础上加 'kelly_sweep'
op.execute("ALTER TABLE ml.jobs DROP CONSTRAINT IF EXISTS ml_jobs_run_type_check")
op.execute(
    "ALTER TABLE ml.jobs ADD CONSTRAINT ml_jobs_run_type_check "
    "CHECK (run_type IN ("
    "'noop','sync','quality','factors','labels','features',"
    "'train','infer','optuna','seed_avg','train_e2e','prepare','kelly_sweep'))"
)
```

> **实现时必须先核对 alembic head 与当前枚举**（记忆有 alembic drift 教训：补 migration 先 `stamp` 对齐再 `upgrade`）。上面枚举以 `20260606_0004` 为准，若其后又有新 run_type，需以真实 head 的最新枚举为基础加 `kelly_sweep`，勿照抄。`down_revision` 指向真实 head。

### 动作 2：建 `research` schema + 结果表 + 索引

即上文结果表链接，全部 `IF NOT EXISTS` 保证幂等。DDL 见 `research.kelly_sweep_results`。

### 配套 docker exec 脚本（项目规范要求）

DB schema 调整须随附 `docker exec` 可执行脚本。除 alembic 外，提供等价 `.sql` + `.ps1`（内置 `docker exec crypto-postgres psql -U cryptouser -d cryptodb -f ...`），供 NestJS 侧迁移规范对齐与人工核验。两者内容一致（同一 DDL），alembic 为权威执行路径。
