<template>
  <div class="train-e2e-fields">
    <n-form-item label="factor_version" required>
      <n-input
        :value="modelValue.factor_version"
        placeholder="如 v1（纯文本，无下拉，D-10）"
        @update:value="(v: string) => update('factor_version', v)"
      />
    </n-form-item>

    <n-form-item label="label_scheme" required>
      <n-select
        :value="modelValue.label_scheme"
        :options="labelSchemeOptions"
        @update:value="(v: LabelScheme) => update('label_scheme', v)"
      />
    </n-form-item>

    <n-form-item label="新股最少上市天数">
      <n-input-number
        :value="modelValue.new_listing_min_days"
        :min="0"
        :max="250"
        clearable
        placeholder="60"
        @update:value="(v: number | null) => update('new_listing_min_days', v)"
      />
    </n-form-item>

    <n-form-item label="日期范围" required>
      <n-date-picker
        :value="modelValue.date_range"
        type="daterange"
        clearable
        :default-value="defaultRange"
        @update:value="(v: [number, number] | null) => update('date_range', v)"
      />
    </n-form-item>

    <n-divider />

    <n-form-item label="模型" required>
      <n-select
        :value="modelValue.model"
        :options="modelOptions"
        @update:value="(v: ModelKind) => update('model', v)"
      />
    </n-form-item>

    <LstmHyperFields
      v-if="modelValue.model === 'lstm'"
      :model-value="lstmModel"
      @update:model-value="onLstmUpdate"
    />

    <n-form-item label="Walk-Forward">
      <n-switch
        :value="modelValue.walk_forward"
        @update:value="(v: boolean) => update('walk_forward', v)"
      />
    </n-form-item>

    <n-form-item label="随机种子（可选）">
      <n-input-number
        :value="modelValue.seed"
        :min="0"
        clearable
        placeholder="42"
        @update:value="(v: number | null) => update('seed', v)"
      />
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { computed, watch } from 'vue'
import {
  NDatePicker, NDivider, NFormItem, NInput, NInputNumber, NSelect, NSwitch,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import LstmHyperFields from './LstmHyperFields.vue'
import type { LstmHyperModel } from './LstmHyperFields.vue'

export type LabelScheme = 'strategy-aware' | 'fwd_5d_ret' | 'dir3_band' | 'dir3_tercile'
export type ModelKind = 'lgb-lambdarank' | 'linear' | 'gbdt' | 'lstm'

export interface E2EFormModel {
  factor_version: string
  label_scheme: LabelScheme
  /** null = 走后端默认 60（交易日） */
  new_listing_min_days: number | null
  /** 本地午夜 ms（n-date-picker daterange 原生格式，CLAUDE.md 硬约束） */
  date_range: [number, number] | null
  model: ModelKind
  walk_forward: boolean
  seed: number | null
  /** 仅 model==='lstm' 时有意义；其它模型忽略 */
  lstm?: LstmHyperModel
}

interface LabelSchemeOption extends SelectOption {
  label: string
  value: LabelScheme
}
interface ModelOption extends SelectOption {
  label: string
  value: ModelKind
}

const props = defineProps<{ modelValue: E2EFormModel }>()
const emit = defineEmits<{
  'update:modelValue': [value: E2EFormModel]
}>()

const labelSchemeOptions: LabelSchemeOption[] = [
  { label: 'strategy-aware', value: 'strategy-aware' },
  { label: 'fwd_5d_ret', value: 'fwd_5d_ret' },
  { label: '次日方向·固定阈值带 (dir3_band)', value: 'dir3_band' },
  { label: '次日方向·截面三分位 (dir3_tercile)', value: 'dir3_tercile' },
]

const modelOptions: ModelOption[] = [
  { label: 'LightGBM LambdaRank', value: 'lgb-lambdarank' },
  { label: '线性回归', value: 'linear' },
  { label: 'GBDT', value: 'gbdt' },
  { label: 'LSTM（次日方向三分类）', value: 'lstm' },
]

const EMPTY_LSTM: LstmHyperModel = {
  lookback: null,
  hidden_size: null,
  num_layers: null,
  dropout: null,
  learning_rate: null,
  epochs: null,
  batch_size: null,
}

const lstmModel = computed<LstmHyperModel>(() => props.modelValue.lstm ?? EMPTY_LSTM)

function onLstmUpdate(value: LstmHyperModel) {
  update('lstm', value)
}

/**
 * 默认联动（降低误配）：
 *  - 选 lstm 且当前 label_scheme 非 dir3_* → 自动切 'dir3_band'
 *  - 切回非 lstm 且当前 dir3_* → 切回 'strategy-aware'
 * 用户仍可手动覆盖（非强制）。
 */
watch(
  () => props.modelValue.model,
  (model) => {
    const scheme = props.modelValue.label_scheme
    const isDir3 = scheme === 'dir3_band' || scheme === 'dir3_tercile'
    if (model === 'lstm' && !isDir3) {
      update('label_scheme', 'dir3_band')
    } else if (model !== 'lstm' && isDir3) {
      update('label_scheme', 'strategy-aware')
    }
  },
)

/** 默认近 30 天，本地午夜口径（CLAUDE.md 硬约束：禁 getUTC*） */
const defaultRange = computed<[number, number]>(() => {
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  return [end - 30 * 86_400_000, end]
})

function update<K extends keyof E2EFormModel>(key: K, value: E2EFormModel[K]) {
  emit('update:modelValue', { ...props.modelValue, [key]: value })
}
</script>

<style scoped>
.train-e2e-fields {
  display: contents;
}
</style>
