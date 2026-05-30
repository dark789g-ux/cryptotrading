# 05 · 前端（Vue 3 + Naive UI + ECharts）

[← 返回 index](./index.md)

本文定义前端改动：训练触发下拉、LSTM 超参子表单、参数装配、分类结果展示组件，
以及 ≤500 行 CI 守则。所有路径在 `apps/web/src/`。

## 1. 下拉同步

### 1.1 `components/quant/train-modal/TrainE2EFields.vue`

```ts
// L76-77 类型
export type LabelScheme = 'strategy-aware' | 'fwd_5d_ret' | 'dir3_band' | 'dir3_tercile'
export type ModelKind = 'lgb-lambdarank' | 'linear' | 'gbdt' | 'lstm'

// L105-108 labelSchemeOptions 追加
{ label: '次日方向·固定阈值带 (dir3_band)', value: 'dir3_band' },
{ label: '次日方向·截面三分位 (dir3_tercile)', value: 'dir3_tercile' },

// L110-114 modelOptions 追加
{ label: 'LSTM（次日方向三分类）', value: 'lstm' },
```

### 1.2 `components/quant/QuantTrainTriggerModal.vue`

`trainModelOptions`（L133-137）追加 `{ label: 'LSTM', value: 'lstm' }`。

### 1.3 `components/quant/train-modal/buildParams.ts`

`TrainTriggerFormShape.train.model` 类型（L15）加 `'lstm'`。

### 1.4 默认联动（降低误配）

```text
当 model 选 'lstm' 时，若当前 label_scheme 不是 dir3_*，自动切到 'dir3_band'（默认）。
当 model 切回 lgb/linear/gbdt 时，若当前是 dir3_*，自动切回 'strategy-aware'。
联动在 TrainE2EFields 内 watch(model) 实现；用户仍可手动覆盖（不强制）。
```

## 2. LSTM 超参子表单（新增组件）

新增 `components/quant/train-modal/LstmHyperFields.vue`，**仅当
`model === 'lstm'`** 时在 `TrainE2EFields` 内条件渲染：

```text
┌─ LSTM 超参（model=lstm 时显示）──────────────┐
│ lookback        [n-input-number] 默认 32     │
│ hidden_size     [n-input-number] 默认 128    │
│ num_layers      [n-input-number] 默认 2      │
│ dropout         [n-input-number] 默认 0.2    │
│ learning_rate   [n-input-number] 默认 0.001  │
│ epochs          [n-input-number] 默认 50     │
│ batch_size      [n-input-number] 默认 512    │
│ seed            （复用 E2E 现有 seed 字段）   │
└──────────────────────────────────────────────┘
```

- 字段全部 `clearable`，留空 = 不传 = 后端用 `DEFAULT_LSTM_HYPERPARAMS`
  （[02](./02-python-training.md) 单一真理源；前端 placeholder 仅提示默认值，
  **不**在前端重复 hardcode 默认值落进 payload）。
- 子表单独立文件控制 `TrainE2EFields.vue` 行数（现 132 行，加条件渲染入口约 +15 行）。

### `E2EFormModel` 扩展

```ts
export interface E2EFormModel {
  // ...现有字段...
  /** 仅 model==='lstm' 时有意义；其它模型忽略 */
  lstm?: {
    lookback: number | null
    hidden_size: number | null
    num_layers: number | null
    dropout: number | null
    learning_rate: number | null
    epochs: number | null
    batch_size: number | null
  }
}
```

## 3. 参数装配（buildParams.ts）

`train_e2e` 分支（L54-68）在 `params` 中按需加 `hyperparams`。

> **改写说明**：现有 `buildParams.ts:54-67` 的 `train_e2e` 分支是**直接 `return { run_type, params: {字面量} }`**、
> 无中间变量。落地时需把它重写为"先建可变 `params` 对象、按 `model==='lstm'` 条件
> 插入 `hyperparams`、再 return"的形式（如下）。这是结构改写，不是现状。

```ts
if (form.run_type === 'train' && modeIsE2E) {
  const e = form.e2e
  const params: Record<string, unknown> = {
    factor_version: e.factor_version.trim(),
    label_scheme: e.label_scheme,
    new_listing_min_days: e.new_listing_min_days ?? 60,
    date_range: formatDateRange(e.date_range as [number, number]),
    model: e.model,
    walk_forward: e.walk_forward,
    seed: e.seed ?? 42,
  }
  if (e.model === 'lstm' && e.lstm) {
    // 仅打包用户显式填写的项（null 跳过 → 后端补默认，避免前端双源默认值）
    const hp = pickDefined(e.lstm)   // 过滤 null/undefined
    if (Object.keys(hp).length > 0) params.hyperparams = hp
  }
  return { run_type: 'train_e2e', params }
}
```

`pickDefined` 是新增小工具（buildParams.ts 内，纯函数，可单测）。

## 4. 分类结果展示（新增组件）

`oos_metrics` 现由 `QuantRunDetailView` → `OverallMetricsPanel` 渲染（排序指标
NDCG/IC 专用）。LSTM 分类 Run 需展示混淆矩阵 + accuracy/F1，新增组件并按
`oos_metrics.task` 条件渲染。

### 4.1 `components/quant/run-detail/ClassMetricsPanel.vue`（新增）

```text
渲染条件：run.oos_metrics.task === 'classification_3class'
布局：
┌─ 分类指标 ───────────────────────────────────┐
│ [Accuracy 0.41] [Macro-F1 0.39]              │  ← 复用 MetricBadge
├─ 混淆矩阵 ────────────────────────────────────┤
│           预测跌  预测横盘  预测涨             │
│  实际跌    420     510      270               │  ← n-table 或 ECharts heatmap
│  实际横盘  380     980      740               │
│  实际涨    300     560      320               │
├─ 各类 P/R/F1 ─────────────────────────────────┤
│  跌  P .40 R .38 F1 .39 (n=1200)             │  ← 小表格
│  横盘 ...                                     │
│  涨  ...                                      │
└───────────────────────────────────────────────┘
```

- 混淆矩阵建议用 ECharts heatmap（与项目 ECharts 栈一致）或 `n-table`；
  二选一，落地时取简洁者，行=真实类、列=预测类、顺序 [跌, 横盘, 涨]。
- 复用 `MetricBadge`（accuracy/macro_f1，阈值色映射）。

### 4.2 `QuantRunDetailView.vue` 接线

```text
现状 6 列网格：Header / OverallMetricsPanel / Hyperparams+SHAP / FoldMetricsTable
改为按 oos_metrics.task 分支：
  · 'classification_3class' → ClassMetricsPanel（替代 OverallMetricsPanel）
                              + Hyperparams（SHAP 区因 shap_uri 空自动不显示）
                              + FoldMetricsTable（fold 列改显 accuracy/macro_f1，
                                                  FoldMetricsTable 已兼容多字段名，
                                                  扩展其字段映射即可）
  · 其它（排序任务） → 维持现有 OverallMetricsPanel 路径不动
```

`QuantRunDetailView.vue` 现 160 行，加一个 `v-if/v-else` 分支约 +20 行，仍远低于 500。
`FoldMetricsTable.vue`（107 行）扩展字段映射（加 accuracy/macro_f1 列，分类 Run 时
显示），仍 < 500。

## 5. SHAP 区零改动

`QuantRunDetailView` 的 SHAP 区已对 `shap_uri == null` 优雅处理（不渲染
`ShapBarChart`）。LSTM `shap_uri=NULL` → SHAP 区自动隐藏，**前端无需特判**。

## 6. ≤500 行 CI 守则（lint:quant-lines）

```text
新增/改动文件预估行数（均 < 500）：
  LstmHyperFields.vue           ~110   [新]
  ClassMetricsPanel.vue         ~150   [新]
  TrainE2EFields.vue       132→ ~160   [改]（+lstm 条件渲染入口 + 联动 watch）
  QuantRunDetailView.vue   160→ ~185   [改]
  FoldMetricsTable.vue     107→ ~135   [改]
  QuantTrainTriggerModal.vue 255→~258  [改]
落地后必跑：pnpm --filter @cryptotrading/web lint:quant-lines（见 06）
若 TrainE2EFields 因联动逻辑膨胀逼近上限 → 把 watch 联动抽到 train-modal/ 下小工具模块。
```

下一篇：[06-deps-and-testing.md](./06-deps-and-testing.md)
