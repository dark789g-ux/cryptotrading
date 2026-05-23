# 05 NestJS + 前端:DTO + Modal + 子组件 + RunDetail

## NestJS 层

### `apps/server/src/entities/ml/ml-job.entity.ts`

```typescript
export type MlJobRunType =
  | 'noop' | 'sync' | 'quality' | 'factors' | 'labels' | 'features'
  | 'train' | 'infer' | 'optuna' | 'seed_avg'
  | 'train_e2e';   // ← 新增

@Column({ type: 'jsonb', default: () => "'{}'::jsonb" })
result_payload!: Record<string, unknown>;   // ← 新增列
```

### `apps/server/src/modules/quant/dto/create-job.dto.ts`

```typescript
export const ALLOWED_RUN_TYPES = [
  'noop','sync','quality','factors','labels','features',
  'train','infer','optuna','seed_avg','train_e2e',
] as const;

// 现有 validateCreateJob 不变,run_type 校验靠 ALLOWED_RUN_TYPES 自动覆盖。
// params 内部结构仍由 Python worker 端 _validate_params 严格校验。
```

**不在 NestJS 端做 params 字段校验** —— 保持与现有 `train` / `optuna` 一致(透传 jsonb)。新增 run_type 不引入 DTO 分支负担。

### NestJS 单测 `dto/__tests__/create-job.dto.spec.ts`

```typescript
it('accepts train_e2e run_type', () => {
  expect(validateCreateJob({
    run_type: 'train_e2e',
    params: {
      factor_version: 'v1', label_scheme: 'strategy-aware',
      new_listing_min_days: 60, date_range: '20240601:20240630',
      model: 'lgb-lambdarank', walk_forward: true, seed: 42,
    },
  })).toEqual(expect.any(Object));
});

it('rejects unknown run_type', () => {
  expect(() => validateCreateJob({ run_type: 'train_e2e_extra', params: {} }))
    .toThrow(/run_type/);
});
```

## 前端类型层

### `apps/web/src/api/modules/quant.ts`

```typescript
export type JobRunType =
  | 'noop' | 'sync' | 'quality' | 'factors' | 'labels' | 'features'
  | 'train' | 'infer' | 'optuna' | 'seed_avg'
  | 'train_e2e';   // ← 新增
```

## TrainE2EFields 子组件(D-19)

### 新文件 `apps/web/src/components/quant/train-modal/TrainE2EFields.vue`

职责:仅渲染端到端模式的表单字段块。父组件通过 `v-model` 透传所有字段。

```vue
<template>
  <n-form-item label="factor_version" required>
    <n-input v-model:value="model.factor_version"
             placeholder="如 v1(纯文本,无下拉,D-10)" />
  </n-form-item>
  <n-form-item label="label_scheme" required>
    <n-select v-model:value="model.label_scheme" :options="schemeOptions" />
  </n-form-item>
  <n-form-item label="new_listing_min_days">
    <n-input-number v-model:value="model.new_listing_min_days"
                    :min="0" :max="250" clearable :placeholder="60" />
  </n-form-item>
  <n-form-item label="date_range" required>
    <n-date-picker v-model:value="model.date_range"
                   type="daterange"
                   :default-value="defaultRange" />
  </n-form-item>
  <n-divider />
  <n-form-item label="模型" required>
    <n-select v-model:value="model.model" :options="modelOptions" />
  </n-form-item>
  <n-form-item label="walk_forward">
    <n-switch v-model:value="model.walk_forward" />
  </n-form-item>
  <n-form-item label="seed">
    <n-input-number v-model:value="model.seed" clearable :placeholder="42" />
  </n-form-item>
</template>

<script setup lang="ts">
import { computed } from 'vue';
import { NFormItem, NInput, NInputNumber, NSelect,
         NDatePicker, NDivider, NSwitch, type SelectOption } from 'naive-ui';

export interface E2EFormModel {
  factor_version: string;
  label_scheme: 'strategy-aware' | 'fwd_5d_ret';
  new_listing_min_days: number | null;
  date_range: [number, number] | null;       // 本地午夜 ms
  model: 'lgb-lambdarank' | 'linear' | 'gbdt';
  walk_forward: boolean;
  seed: number | null;
}

const props = defineProps<{ modelValue: E2EFormModel }>();
const emit = defineEmits<{ 'update:modelValue': [v: E2EFormModel] }>();

const model = computed({
  get: () => props.modelValue,
  set: (v) => emit('update:modelValue', v),
});

const schemeOptions: SelectOption[] = [
  { label: 'strategy-aware(策略感知)', value: 'strategy-aware' },
  { label: 'fwd_5d_ret(5 日远期收益,兜底)', value: 'fwd_5d_ret' },
];
const modelOptions: SelectOption[] = [
  { label: 'lgb-lambdarank', value: 'lgb-lambdarank' },
  { label: 'linear', value: 'linear' },
  { label: 'gbdt', value: 'gbdt' },
];

const defaultRange = computed<[number, number]>(() => {
  // CLAUDE.md 硬约束:n-date-picker 本地午夜口径,禁 getUTC*
  const now = new Date();
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const start = end - 30 * 86400_000;
  return [start, end];
});
</script>
```

**文件估行**:80-100 行,远低于 500 上限。

## QuantTrainTriggerModal.vue 改造

### Template 关键变化

```vue
<template>
  <AppModal v-model:show="visible" title="新建训练作业" :width="640">
    <n-form ...>
      <n-form-item label="作业类型">
        <n-select v-model:value="form.run_type" :options="runTypeOptions" />
      </n-form-item>

      <!-- 仅 train 时显示 mode 切换(D-8) -->
      <n-form-item v-if="form.run_type === 'train'" label="模式">
        <n-switch v-model:value="modeIsE2E">
          <template #checked>端到端</template>
          <template #unchecked>使用现有 feature_set</template>
        </n-switch>
      </n-form-item>

      <!-- 端到端字段块 -->
      <TrainE2EFields v-if="form.run_type === 'train' && modeIsE2E"
                      v-model="form.e2e" />

      <!-- 老 existing feature_set 模式 -->
      <template v-if="form.run_type === 'train' && !modeIsE2E">
        <!-- 现有 feature_set_id / model / walk_forward / seed(保留) -->
      </template>

      <!-- optuna / seed_avg(D-9 不动) -->
      <template v-if="form.run_type === 'optuna'">...</template>
      <template v-if="form.run_type === 'seed_avg'">...</template>

      <n-form-item label="优先级">
        <n-input-number v-model:value="form.priority" />
      </n-form-item>
    </n-form>

    <template #actions>
      <n-button @click="onCancel">取消</n-button>
      <n-button type="primary" :loading="submitting" :disabled="!canSubmit"
                @click="onSubmit">提交</n-button>
    </template>
  </AppModal>
</template>
```

### Script 关键变化

```typescript
const form = reactive({
  run_type: 'train' as JobRunType,
  priority: 100,
  train: { feature_set_id: '', model: 'lgb-lambdarank', walk_forward: true, seed: 42 },
  e2e: {
    factor_version: '',
    label_scheme: 'strategy-aware',
    new_listing_min_days: null,
    date_range: null,
    model: 'lgb-lambdarank',
    walk_forward: true,
    seed: null,
  } as E2EFormModel,
  optuna: { ... },         // 不变
  seed_avg: { ... },       // 不变
});
const modeIsE2E = ref(true);   // 默认端到端(D-8)


const canSubmit = computed(() => {
  if (form.run_type === 'train' && modeIsE2E.value) {
    const e = form.e2e;
    return !!e.factor_version.trim()
        && !!e.label_scheme
        && Array.isArray(e.date_range)
        && !!e.date_range[0] && !!e.date_range[1]
        && !!e.model;
  }
  if (form.run_type === 'train') {
    return !!form.train.feature_set_id.trim();
  }
  // optuna / seed_avg 沿用既有
  ...
});


function buildParams(): { run_type: JobRunType; params: Record<string, unknown> } {
  if (form.run_type === 'train' && modeIsE2E.value) {
    return {
      run_type: 'train_e2e',
      params: {
        factor_version: form.e2e.factor_version.trim(),
        label_scheme: form.e2e.label_scheme,
        new_listing_min_days: form.e2e.new_listing_min_days ?? 60,
        date_range: formatDateRange(form.e2e.date_range!),
        model: form.e2e.model,
        walk_forward: form.e2e.walk_forward,
        seed: form.e2e.seed ?? 42,
      },
    };
  }
  // 老 train / optuna / seed_avg 不变
  ...
}


function formatDateRange(range: [number, number]): string {
  const fmt = (ms: number) => {
    const d = new Date(ms);
    // CLAUDE.md 硬约束:本地午夜口径,禁 getUTC*
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}${m}${day}`;
  };
  return `${fmt(range[0])}:${fmt(range[1])}`;
}


async function onSubmit() {
  ...
  const { jobId } = await createJob(buildParams());
  emit('submitted', jobId);

  if (form.run_type === 'train' && modeIsE2E.value) {
    message.success('作业已入队。端到端训练预计 20-40 分钟,期间其他 pending 作业会排队。');
  } else {
    message.success('作业已入队。');
  }
  visible.value = false;
}
```

### 文件行数预算

- 现有 229 行
- 加 mode 切换 + 端到端分支 + buildParams 分支 + formatDateRange + toast:估 +110 行
- **总 ~340 行,远低于 500**

## RunDetail 与 Jobs view

### `apps/web/src/components/quant/run-detail/HyperparamsPanel.vue`

**零修改**(D-21)。当前面板已经遍历 `hyperparams` 对象渲染所有 key,新跑的 train_e2e 自然多出 `factor_version` / `label_scheme` / `new_listing_min_days` 三行,老 record 显示原有字段。

### `apps/web/src/views/quant/QuantJobsView.vue`

```typescript
const runTypeOptions = [
  { label: 'train', value: 'train' },
  { label: 'train_e2e', value: 'train_e2e' },   // ← 新增
  { label: 'optuna', value: 'optuna' },
  // ... 其他不变
];

// 若 run_type 列有 tag 颜色映射,给 train_e2e 加一个独特色
const runTypeTagType: Record<JobRunType, 'success' | 'info' | 'warning' | 'default'> = {
  ...
  train_e2e: 'success',
};
```

## vitest 单测

详见 [06-testing-and-acceptance.md](./06-testing-and-acceptance.md#前端-vitestquanttraintriggermodalspects)。

## 文档更新

### `apps/web/src/views/quant/README.md`

```markdown
### 端到端训练模式(train_e2e)

新建训练作业时,默认走"端到端"模式 —— 填一张表后,worker 自动按顺序跑:
1. **labels build**(进度 0-30%)
2. **features build**(进度 30-60%)→ 产出 feature_set_id
3. **train**(进度 60-100%)

切换到"使用现有 feature_set"可走老路径(直接指定 feature_set_id)。

注意:
- 端到端模式预计 20-40 分钟,期间其他 pending 作业会排队
- new_listing_min_days 默认 60(交易日),0 等价不过滤
- 元信息(factor_version / label_scheme / new_listing_min_days)写入
  model_runs.hyperparams 便于审计
```

### `apps/quant-pipeline/README.md`

```markdown
uv run quant train-e2e --factor-version v1 --label-scheme strategy-aware \
  --new-listing-min-days 30 --date-range 20240601:20240630 --model lgb-lambdarank
```

并在 M3/M4 段加:`run_type='train_e2e'` 由 worker 顺序执行 labels→features→train。
