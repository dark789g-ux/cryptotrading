# 04 · 前端交互

前置：后端 API 见 [03](./03-backend-decoupling.md)。约束：Vue 单文件 ≤500 行（`lint:quant-lines` CI 强制），modal 拆子组件。涉及文件：`apps/web/src/views/quant/QuantJobsView.vue`、`components/quant/QuantTrainTriggerModal.vue`、`components/quant/train-modal/*`。

## 备料 modal（新增 QuantPrepareModal）

```text
┌─ 备料 (prepare) ───────────────────────────────────┐
│  命名标签 L  [下拉 listLabels({enabled:true})]      │
│  factor_version V  [下拉 listFactorVersions, 可手输]│
│  目标区间 [start,end]  [n-date-picker daterange]    │
│      ↑ 备料就是要扩范围, 此处不做 disable           │
│  ── 备料参数 ──────────────────────────────────────│
│  new_listing_min_days [number, 默认提示 60]         │
│  中性化 cols / robust_z / factor_clip_sigma         │
│  label_winsorize / max_hold_days(strategy_aware)    │
│  [ ] force_recompute  (默认关)                      │
│              [取消]            [开始备料]            │
└─────────────────────────────────────────────────────┘
→ POST job run_type=prepare, params={label_ref, factor_version,
    date_range, new_listing_min_days, neutralize_cols, robust_z,
    factor_clip_sigma, label_winsorize, max_hold_days?, force_recompute}
→ SSE 进度复用 ml.jobs(先 POST sse-token 再 query 建连)
```

备料参数即原 `TrainE2EFields` 里属于 labels/features 的那部分字段，整体迁到此 modal。

## 训练 modal（改造 QuantTrainTriggerModal，删端到端表单）

```text
┌─ 训练 (train/optuna/seed_avg) ─────────────────────┐
│  run_type  [train | optuna | seed_avg]              │
│  已备 feature_set  [下拉]                           │
│    ← GET /api/quant/feature-sets?materialized=true  │
│    显示: 「标签名·v2 · factor_version · 覆盖 2020~2024(2段)」│
│  date_range  [n-date-picker, is-date-disabled]      │
│    disable: < R_F.min  /  > R_F.max  /  落空洞段     │
│  ── 训练参数(保留现有) ────────────────────────────│
│  model / walk_forward / walk_forward_params         │
│  seed / hyperparams / skip_shap                     │
│              [取消]            [开始训练]            │
└─────────────────────────────────────────────────────┘
→ POST job, params={feature_set_id, date_range, model, walk_forward,
    walk_forward_params, seed, hyperparams, skip_shap}
```

**关键翻转**：不再填 factor_version/命名标签/备料参数（那些在备料时已锁进 feature_set_id）；改为从"已备好的 feature_set"里选一个。

## is-date-disabled 机制（决策 3 甲 + 决策 6 空洞）

```text
选中 feature_set fs 后:
  coverage = 该 fs 的 R_F = [{start,end}, ...]  // 来自列表 API 的 coverage 字段
  isDateDisabled(ts):
    d = ts→YYYYMMDD
    return 不存在任何段 (s,e) 使 s <= d <= e     // 区间外 + 空洞 一律禁用
```

- fs 未选时 date_range 禁用（无可选区间）。
- 切换 fs 重算 coverage、清空已选 date_range。
- 覆盖区间摘要在下拉项 + 选中后提示文案展示（"可选 2020-01-02 ~ 2024-12-31，缺口 2022 全年"）——让用户看见空洞，不静默。

## labels / features 单独触发入口（精细补救，低频）

放 `QuantJobsView` 的「更多操作 / 高级」折叠区，不占主流程：

```text
[补 labels]  选 命名标签L + 区间 + [force]  → run_type=labels
[补 features] 选 已备 fs(或 V+L) + 区间 + [force] → run_type=features
```

用途：只想补某段 labels 不重算 features；或 features 因之前缺 labels 跳过、补齐 labels 后单独重跑 features。

## 与命名标签/标签库的衔接
- 备料/单独 labels 入口的"命名标签"复用 `QuantLabelsView` 的 `label_definitions`（`listLabels`）。
- 训练列表的 `label_name` 来自 03 的 API（feature_sets.label_id JOIN label_definitions），缺则显示 scheme。

## 前端单测（vitest，详见 06）
- `isDateDisabled` 纯函数：区间内/区间外/空洞/边界。
- 两个 modal 渲染 + 提交 payload 组装。
- 切换 fs 重置 date_range 的联动。
