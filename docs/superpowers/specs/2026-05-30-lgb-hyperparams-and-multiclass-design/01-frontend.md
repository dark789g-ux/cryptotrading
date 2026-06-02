# 01 · 前端（表单、字段、布局、buildParams、联动）

> 上级：[index.md](./index.md)。后端透传见 [02](./02-backend-passthrough.md)，lgb-multiclass 见 [03](./03-lgb-multiclass.md)。

## 组件拆分总览

```text
QuantTrainTriggerModal.vue（创建训练 Modal，已存在）
 ├─ 普通 train 区（已存在）
 │    └─ <LgbHyperFields/>            ← 新增：model ∈ {lgb-lambdarank, lgb-multiclass} 时显示
 └─ <TrainE2EFields/>（已存在，改造）
      ├─ factor_version  → n-select（动态下拉，改造）
      ├─ label_scheme / date_range / model / walk_forward / seed（已存在）
      ├─ n-collapse「模型超参」
      │    └─ <LgbHyperFields/>       ← 新增：lgb 系模型显示；lstm 仍走 <LstmHyperFields/>
      └─ n-collapse「特征 / 标签参数」（仅 E2E）
           └─ <FeatureLabelFields/>   ← 新增
```

新增组件（均 < 500 行，满足 `lint:quant-lines`）：
- `apps/web/src/components/quant/train-modal/LgbHyperFields.vue`（lgb 系共用）
- `apps/web/src/components/quant/train-modal/FeatureLabelFields.vue`（特征/标签参数）

改造：`TrainE2EFields.vue`、`QuantTrainTriggerModal.vue`、`buildParams.ts`。

## 布局（方案 A：折叠式高级选项）

```text
┌─ 创建训练（E2E）─────────────────────────────┐
│ 基础（常驻）                                  │
│   factor_version[下拉]  label_scheme[下拉]    │
│   date_range  model  walk_forward  seed       │
│   dir3_band_eps（仅 dir3_band，已存在）        │
│                                               │
│ ▶ 模型超参（默认收起）                         │
│     lgb 系 → <LgbHyperFields/>（9 项）         │
│     lstm   → <LstmHyperFields/>（已存在 7 项） │
│ ▶ 特征 / 标签参数（默认收起，仅 E2E）          │
│     <FeatureLabelFields/>                      │
└───────────────────────────────────────────────┘
```

设计原则（沿用 LSTM 既有约定）：所有高级字段 `clearable`，**留空 = 不传 = 后端用默认值**；前端 placeholder 仅提示默认值，**不**在前端 hardcode 默认值落进 payload（单一真理源在 Python）。

## LgbHyperFields

`apps/web/src/components/quant/train-modal/LgbHyperFields.vue`，被 E2E 与普通 train 复用；服务 `lgb-lambdarank` 与 `lgb-multiclass`（两者共享 LightGBM 树参数）。

接口：

```typescript
export interface LgbHyperModel {
  num_leaves: number | null
  min_data_in_leaf: number | null
  feature_fraction: number | null
  learning_rate: number | null
  num_boost_round: number | null
  early_stopping_rounds: number | null
  bagging_fraction: number | null
  lambda_l1: number | null
  lambda_l2: number | null
}
```

字段表（控件均 `n-input-number` + `clearable`）：

| 字段 | min | max | step | 默认(placeholder) | 含义 |
|------|-----|-----|------|------|------|
| `num_leaves` | 15 | 127 | 1 | 31 | 树复杂度 |
| `min_data_in_leaf` | 50 | 500 | 10 | 200 | 叶最小样本 |
| `feature_fraction` | 0.5 | 1.0 | 0.05 | 0.85 | 列采样 |
| `learning_rate` | 0.01 | 0.2 | 0.005 | 0.05 | 学习率 |
| `num_boost_round` | 50 | 2000 | 50 | 500 | 迭代轮数 |
| `early_stopping_rounds` | 10 | 200 | 10 | 50 | 早停 |
| `bagging_fraction` | 0.5 | 1.0 | 0.05 | 0.85 | 行采样 |
| `lambda_l1` | 0 | — | 0.1 | 0 | L1 正则 |
| `lambda_l2` | 0 | — | 0.1 | 0 | L2 正则 |

> 普通 train 模式特例：single_fold 路径硬编码 `early_stopping_rounds=None`（`single_fold_runner.py:107`，防测试集泄漏）。故在普通 train 区渲染该字段时加 `disabled` + tooltip「仅 walk_forward 模式生效」，避免静默失效误导。E2E 默认 walk_forward 路径下早停生效，不禁用。

## FeatureLabelFields（仅 E2E）

`apps/web/src/components/quant/train-modal/FeatureLabelFields.vue`。

接口：

```typescript
export interface FeatureLabelModel {
  neutralize_cols: 'none' | 'industry' | 'industry_mv' | null  // 三档单选
  robust_z: boolean | null
  factor_clip_sigma: number | null
  label_winsorize_lo: number | null
  label_winsorize_hi: number | null
  fwd_horizon_days: number | null   // 仅 fwd_5d_ret
  max_hold_days: number | null      // 仅 strategy-aware
}
```

特征参数（常驻面板内）：

| 字段 | 控件 | 选项 / 范围 | 默认 | 含义 |
|------|------|------|------|------|
| `neutralize_cols` | n-select | 无中性化 / 行业 / 行业+市值 | 行业+市值 | 中性化维度 |
| `robust_z` | n-switch | 开 / 关 | 开 | 稳健标准化 |
| `factor_clip_sigma` | n-input-number | 1.5–5.0, step 0.5 | 3.0 | 因子截尾 σ |
| `label_winsorize_lo` | n-input-number | -1.0 ~ 0（不含 0） | -0.5 | 标签截尾下界 |
| `label_winsorize_hi` | n-input-number | 0（不含）~ 1.0 | 0.5 | 标签截尾上界 |

`neutralize_cols` 前端三档枚举 → 后端语义映射（在 buildParams 转换）：

```text
'none'         → []
'industry'     → ['industry_l1']
'industry_mv'  → ['industry_l1', 'mv']
```

标签方案条件参数（随 `label_scheme` 显隐）：

```text
label_scheme === 'fwd_5d_ret'    → fwd_horizon_days  [n-select 3/5/10, 默认 5]
label_scheme === 'strategy-aware'→ max_hold_days      [n-input-number 10-30, 默认 20]
label_scheme === 'dir3_band'     → dir3_band_eps（已存在，不在本组件）
```

## factor_version 动态下拉

`TrainE2EFields.vue` 内把 `factor_version` 从文本框改为 `n-select`：

- options 来自新增 `GET /api/quant/factor-versions`（见 [02](./02-backend-passthrough.md#factor-versions-api)）。
- 加载态 `loading`；请求失败时给非阻塞错误提示并保留可手输（`filterable` + `tag`），不因接口故障卡死创建流程。
- `onActivated` / `onMounted` 拉取（注意 keep-alive：放 `onActivated` 防切回不刷新，遵循 CLAUDE.md keep-alive 规范）。

## 联动逻辑（TrainE2EFields.vue）

扩展现有 `watch(() => props.modelValue.model)`（当前 `TrainE2EFields.vue:178-189` 处理 lstm↔dir3）：

```text
model === 'lstm'          → 若 label_scheme 非 dir3 系，自动切 'dir3_band'
model === 'lgb-multiclass'→ 若 label_scheme 非 dir3 系，自动切 'dir3_band'   ← 新增
model ∈ {lgb-lambdarank, linear, gbdt} → 若 label_scheme 是 dir3 系，自动切回 'strategy-aware'
```

超参组件按 model 条件渲染：

```text
model === 'lstm'                              → <LstmHyperFields/>
model ∈ {lgb-lambdarank, lgb-multiclass}      → <LgbHyperFields/>
model ∈ {linear, gbdt}                        → 不显示模型超参面板（无可调）
```

## buildParams.ts 打包

`apps/web/src/components/quant/train-modal/buildParams.ts`，两处分支均扩展，沿用 `pickDefined`（仅打包非 null 项，留空交后端补默认）：

E2E 分支（现 `buildParams.ts:72-93`）追加：

```text
if model ∈ {lgb-lambdarank, lgb-multiclass} 且 form.e2e.lgb:
    hp = pickDefined(form.e2e.lgb)
    if hp 非空: params.hyperparams = hp

# 特征/标签参数（仅 E2E）
fl = form.e2e.featureLabel
if fl.neutralize_cols 非 null: params.neutralize_cols = mapNeutralize(fl.neutralize_cols)
if fl.robust_z 非 null:        params.robust_z = fl.robust_z
if fl.factor_clip_sigma 非 null: params.factor_clip_sigma = ...
if lo 与 hi 均非 null:          params.label_winsorize = [lo, hi]   # 二者需同时填或同时空
if label_scheme==='fwd_5d_ret' 且 fwd_horizon_days 非 null: params.fwd_horizon_days = ...
if label_scheme==='strategy-aware' 且 max_hold_days 非 null: params.max_hold_days = ...
```

普通 train 分支（现 `buildParams.ts:95-104`）追加：

```text
if model ∈ {lgb-lambdarank, lgb-multiclass} 且 form.train.lgb:
    hp = pickDefined(form.train.lgb)
    # early_stopping_rounds 在普通 train 不生效，UI 已 disabled，pickDefined 自然不含它
    if hp 非空: p.hyperparams = hp
# 普通 train 不打包特征/标签参数（特征矩阵已由 feature_set_id 固定）
```

约束：`label_winsorize_lo` 与 `label_winsorize_hi` 必须**同填或同空**；只填一个时前端表单校验报错（区间必须成对）。

## 类型约束（CLAUDE.md）

- 自定义 `n-select` option 接口须 `extends SelectOption`（`import type { SelectOption } from 'naive-ui'`），不重复声明 `label/value`。
- 改 import 块 / 顶层声明后回读文件头部验证顺序。
- 比较类 UI 不涉及，本处为参数录入，无需字段/常量双类型切换。
