# 03 · 备料/训练解耦（后端）

涵盖 python worker 与 NestJS server 两侧。前置：增量算法见 [02](./02-incremental-algorithm.md)。

## prepare run_type（备料编排）

新增 run_type `prepare`，dispatcher 注册 `_runner_prepare`。编排 = 现 train_e2e 的 `_step_labels → _step_features`，**砍掉 `_step_train`**。

```text
_runner_prepare(job):
  p = 校验 params: label_ref(展开后给 scheme/base_*) + factor_version
                   + date_range + 备料参数 + force_recompute
  step1 = compute_labels(scheme, date_range, new_listing_min_days,
                         max_hold_days?, force_recompute)        # 02 缺口算法
          check cancel
  step2 = build_feature_matrix(factor_version, scheme, date_range,
                         new_listing_min_days, neutralize_cols, robust_z,
                         factor_clip_sigma, label_winsorize, force_recompute)
          → 返回 feature_set_id
  记录 feature_sets 行(若新)含 label_id/label_version (见下「feature_sets 加列」)
  SSE 进度复用现有 ml.jobs 机制
```

**复用策略**：把 `train_e2e_runner.py` 里 `_step_labels`/`_step_features` 的参数组装逻辑抽到 prepare runner（或共享 helper），避免重复。`_step_train` 逻辑本就等价 `train` run_type（见下），随 train_e2e 一并删。

## 训练加载加 date_range 过滤（真解耦硬配套）

当前 `_load_feature_matrix` 无 date_range 过滤（`training/runner.py:97-100`，已核实）。改为：

```sql
SELECT trade_date, ts_code, features, label
FROM factors.feature_matrix
WHERE feature_set_id = :fs
  AND trade_date BETWEEN :start AND :end   -- 新增
ORDER BY trade_date, ts_code
```

- `train` runner `runner_entrypoint`（`training/runner.py:460-495`）新增读 `params.date_range`，解析 `start/end` 传入 `_load_feature_matrix`。
- 不传 date_range 时的兼容：解耦后 date_range 应为**必填**（训练必须指定时段）；缺失则 `raise ValueError`（fail-fast，不退回"读全部"以免悄悄训了全量）。

> 为何必须加：解耦后 `feature_matrix[fs]` 会累积很宽（备料多次扩范围），不按 date_range 过滤就训了全部累积料，决策 3/6 的"时段约束"形同虚设。

## run_type 参数契约理顺

现状已查清：`train`/`optuna`/`seed_avg` 三个训练类 runner **全部直接吃 `feature_set_id`**（`training/runner.py:460`、`seed_averaging.py:408`、`search_spaces.py:62`），**不吃 labelRef/scheme**。但当前 `create-job.dto` 的 `TRAIN_RUN_TYPES`（`:23`）却强制它们必填 labelRef（`:152-155`）——现状混乱，解耦时一并理顺。

新的 run_type → 参数契约：

| run_type | 必填 | 额外校验 |
|----------|------|----------|
| `labels` | labelRef(→scheme) + date_range + 备料参数 (+force?) | — |
| `features` | labelRef(→scheme) + factor_version + date_range + 备料参数 (+force?) | 缺口 ⊆ labels |
| `prepare` | labelRef(→scheme) + factor_version + date_range + 备料参数 (+force?) | — |
| `train`/`optuna`/`seed_avg` | **feature_set_id** + date_range + 模型参数 | date_range ⊆ R_F 且无空洞 |

`create-job.dto` 调整：
- "需 labelRef 的集合"= `{labels, features, prepare}`；**把 train/optuna/seed_avg 移出**（它们不再要 labelRef）。
- 新增"需 feature_set_id 的集合"= `{train, optuna, seed_avg}`：校验 feature_set_id 非空 + date_range 必填 + `⊆R_F`（见下「建 train 类 job 校验」）。
- 三个训练类 runner 统一加 date_range 过滤（都经 `_load_feature_matrix`），见「训练加载加 date_range 过滤」。

## 废弃 train_e2e

```text
- ALLOWED_RUN_TYPES 移除 'train_e2e'           (create-job.dto.ts)
- dispatcher 移除 train_e2e 路由
- 删 train_e2e_runner.py 顶层 run_train_e2e / _step_train
  (labels/features step 逻辑挪进 prepare runner)
- 现有 train_e2e 单测: 改写为 prepare + train 两段, 或迁移断言
```

旧 train_e2e job 历史记录（ml.jobs 里 run_type='train_e2e' 的行）保留只读，不迁移；前端不再产生新的 train_e2e job。

## feature_sets 加列（决策 7）

`factors.feature_sets` 加两列，让训练列表显示友好的命名标签名（非物化登记表，不违背决策 2）：

```text
ALTER TABLE factors.feature_sets
  ADD COLUMN label_id      text NULL,
  ADD COLUMN label_version int  NULL;
```

- 写入时机：prepare/features 物化时，若已知 `label_id/label_version`（来自展开的命名标签）则回填。
- NULL 兼容：历史 feature_sets 行这两列为 NULL，训练列表回退显示 `scheme` 字符串。
- migration 用 alembic（详见 [05](./05-migration-rollout.md)）。

## server：已备 feature_set 列表 API

```text
GET /api/quant/feature-sets?materialized=true
→ [
    {
      feature_set_id,
      label_name, label_version,      // 来自 feature_sets.label_id JOIN label_definitions; 缺则 null
      factor_version, scheme,
      new_listing_min_days, neutralize_cols, robust_z,
      coverage: [{start,end}, ...]    // R_F: feature_matrix[fs] 的连续区间段(server 侧 coverage)
    }, ...
  ]
```

- `materialized=true` 仅返回 feature_matrix 里**有行**的 fs（`EXISTS (SELECT 1 FROM factors.feature_matrix WHERE feature_set_id=...)` 或 join distinct）。
- `coverage` 用 server 侧 SQL 取 `DISTINCT trade_date` 后在内存切连续段（逻辑同 [02 coverage](./02-incremental-algorithm.md#共用基础覆盖区间--缺口查询)；python 与 server 各实现一份，SQL 简单、切段逻辑短）。
- server 与 worker 连同一 PG/库（共享 `ml.jobs`），可直查 `factors.*`；实施时核对 server 的 TypeORM DataSource 是否覆盖 `factors` schema 查询。

## server：建 train 类 job 校验

```text
create job (run_type ∈ {train,optuna,seed_avg}):
  fs = params.feature_set_id
  range = params.date_range  (必填)
  R_F = coverage(feature_matrix, fs)
  if range 越出 R_F 边界 OR range 内落入空洞:
      throw 400 "date_range 超出已备料覆盖, 请先 prepare 补料: 缺 [...]"
```

这是兜底（前端已 disable，见 [04](./04-frontend.md)），防 API 绕过/并发下覆盖区间变化。报错带"缺哪几段"，对应禁止静默截断。
