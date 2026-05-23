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
import { computed } from 'vue'
import {
  NDatePicker, NDivider, NFormItem, NInput, NInputNumber, NSelect, NSwitch,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'

export type LabelScheme = 'strategy-aware' | 'fwd_5d_ret'
export type ModelKind = 'lgb-lambdarank' | 'linear' | 'gbdt'

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
]

const modelOptions: ModelOption[] = [
  { label: 'LightGBM LambdaRank', value: 'lgb-lambdarank' },
  { label: '线性回归', value: 'linear' },
  { label: 'GBDT', value: 'gbdt' },
]

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
