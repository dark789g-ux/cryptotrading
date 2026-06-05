# 01 · 架构总览

## 核心理念
把"生产料（备料）"和"消费料（训练）"彻底分开：
- **备料**可增量累积、不重算重叠（底座见 [02](./02-incremental-algorithm.md)）。
- **训练**只在已备料的覆盖区间 `R_F` 内挑时段，**不再现算料**。

## 数据流全景

```text
┌─ 备料 prepare run_type（增量累积，重叠不重算）────────────┐
│  选 命名标签L + factor_version V + 目标区间 [s,e] + [force] │
│      │ server: expandForTraining(L) → scheme               │
│      ▼                                                      │
│  step1  labels 增量:                                        │
│    查 labels[scheme] 已有 trade_date → 算缺口子区间         │
│    每缺口 [g0,g1] 头部 MA padding + 尾部扩 30 交易日        │
│    只写 [g0,g1] → factors.labels[scheme]                    │
│  step2  features 增量:                                      │
│    缺口 ⊆ labels 覆盖? 否 → warn 跳过(不静默)              │
│    查 feature_matrix[fs] 已有 trade_date → 算缺口(零padding)│
│    factors.daily_factors[V] ⋈ labels + 截面中性化          │
│    → factors.feature_matrix[fs]  +  feature_sets(记 L 信息) │
└────────────────────────────────────────────────────────────┘
                         │ 物化资产逐步累积
                         ▼
┌─ 训练 train/optuna/seed_avg（只消费，不生产）────────────┐
│  前端: 选「已备好的 feature_set」→ 调 API 拿覆盖区间 R_F    │
│        date_range 选择器 disable: <min / >max / 落空洞      │
│  后端: 建 job 校验 date_range ⊆ R_F 且无空洞(兜底防绕过)   │
│  worker: _load_feature_matrix(fs, date_range) ★加过滤★     │
│        → NaN(label) 过滤 → walk-forward 训练               │
└────────────────────────────────────────────────────────────┘
```

`feature_matrix` 是 features inner join labels 的产物，故 `R_F`（某 fs 的 feature_matrix 覆盖区间）天然 ⊆ labels 覆盖区间，训练只需认 `R_F` 一个量（见 [index 关键洞察](./index.md#关键洞察简化了交集语义)）。

## 三层改动清单

```text
Python worker (apps/quant-pipeline) ───────── 详见 02 / 03
├─ + labels_features_incremental.py: gap_subranges() / coverage 区间查询
├─ ~ labels/runner.py:    compute_labels 接 force_recompute + 缺口循环(头/尾 padding)
├─ ~ features/runner.py:  build_feature_matrix 接 force_recompute + 缺口循环(零padding)
│                          + 缺口⊆labels 校验(缺则 warn 跳过)
├─ + worker/prepare_runner.py + dispatcher 注册 prepare; 删 train_e2e 路由
├─ ~ training/runner.py:  _load_feature_matrix 加 date_range; entrypoint 读 date_range
└─ - 删 train_e2e_runner 顶层(labels/features step 逻辑挪进 prepare)

Server (apps/server) ──────────────────────── 详见 03
├─ ~ create-job.dto: ALLOWED_RUN_TYPES +prepare(需labelRef), −train_e2e
├─ + GET 已备 feature_set 列表 API(含覆盖区间 R_F + 命名标签名)
└─ + 建 train/optuna/seed_avg job 时校验 date_range ⊆ R_F 且无空洞

Web (apps/web) ────────────────────────────── 详见 04
├─ + 备料 modal(prepare): 选 L+V+区间+备料参数+force
├─ ~ 训练 modal: 改为「选已备 fs + date_range(disable到R_F)」, 删端到端表单
└─ + labels/features 单独触发入口(精细补救, 低频)

DB (alembic) ──────────────────────────────── 详见 05
└─ + feature_sets 加列 label_id / label_version (训练列表显示标签名)
```

## 组件边界与职责

| 组件 | 做什么 | 依赖 | 接口 |
|------|--------|------|------|
| `gap_subranges()` | 查已物化 → 算缺口子区间 | 结果表 + trade_cal | `(表,键,range)→[(g0,g1)]` |
| `coverage()` | 查 distinct date → 连续区间段 | 结果表 | `(表,键,range)→[(s,e)]` |
| labels 增量 | 缺口循环+头/尾padding+只写缺口 | gap_subranges | `compute_labels(...,force)` |
| features 增量 | 缺口循环+零padding+⊆labels校验 | gap_subranges/coverage | `build_feature_matrix(...,force)` |
| prepare runner | labels→features 串联编排 | 上二者 | `_runner_prepare(job)` |
| 训练加载 | 按 fs+date_range 拉矩阵 | feature_matrix | `_load_feature_matrix(fs,range)` |
| feature-sets API | 列已备 fs + R_F + 标签名 | feature_matrix/feature_sets | `GET /api/quant/feature-sets?materialized=true` |
| job 校验 | date_range ⊆ R_F 且无空洞 | coverage(server侧) | create-job 拦截 |

每个单元可独立测试：`gap_subranges`/`coverage` 是纯函数（给定 trading_days + materialized 集合算输出），mock 即可；增量循环正确性靠真 DB 逐行比对（[06](./06-testing-verification.md)）。

## 不在本次范围
- 物化登记表（决策 2 选 A，明确不做；`coverage()` 封成独立函数，未来要审计追溯再接登记表，调用方不改）。
- 自动检测"历史标的集合变动"（决策 + 约束 4：交由 `force_recompute` 显式兜底）。
- 自动补缺训练（决策 5 否决"丙：自动补缺再训"，坚持真解耦）。
