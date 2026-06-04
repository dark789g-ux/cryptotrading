<template>
  <div class="base-type-fields">
    <n-form-item label="基础类型" required>
      <n-select
        :value="modelValue.base_type"
        :options="baseTypeOptions"
        placeholder="选择基础类型"
        data-testid="label-base-type-select"
        @update:value="onBaseTypeChange"
      />
    </n-form-item>

    <!-- fwd_ret：horizon 天数 -->
    <n-form-item
      v-if="modelValue.base_type === 'fwd_ret'"
      label="horizon（天）"
      required
    >
      <n-input-number
        :value="fwdHorizon"
        :min="1"
        :max="60"
        :step="1"
        placeholder="1=次日, 5=5日…"
        style="width: 180px;"
        data-testid="label-fwd-horizon"
        @update:value="onHorizonChange"
      />
      <span class="unit-hint">天（1=次日涨跌幅）</span>
    </n-form-item>

    <!-- strategy_aware：max_hold_days -->
    <n-form-item
      v-if="modelValue.base_type === 'strategy_aware'"
      label="max_hold_days"
      required
    >
      <n-input-number
        :value="maxHoldDays"
        :min="10"
        :max="30"
        :step="1"
        placeholder="20"
        style="width: 180px;"
        data-testid="label-max-hold-days"
        @update:value="onMaxHoldDaysChange"
      />
      <span class="unit-hint">天（10-30）</span>
    </n-form-item>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NFormItem, NInputNumber, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'

export interface BaseTypeModel {
  base_type: string
  base_params: Record<string, unknown>
}

interface BaseTypeSelectOption extends SelectOption {
  label: string
  value: string
}

const props = defineProps<{ modelValue: BaseTypeModel }>()
const emit = defineEmits<{ 'update:modelValue': [value: BaseTypeModel] }>()

const baseTypeOptions: BaseTypeSelectOption[] = [
  { label: 'fwd_ret（N日涨跌幅）', value: 'fwd_ret' },
  { label: 'strategy_aware（固定策略收益）', value: 'strategy_aware' },
]

const fwdHorizon = computed<number | null>(() => {
  const v = props.modelValue.base_params?.horizon
  return typeof v === 'number' ? v : null
})

const maxHoldDays = computed<number | null>(() => {
  const v = props.modelValue.base_params?.max_hold_days
  return typeof v === 'number' ? v : null
})

function onBaseTypeChange(newType: string) {
  // 切 base_type 时重置 base_params 为对应类型的空值
  let defaultParams: Record<string, unknown> = {}
  if (newType === 'fwd_ret') defaultParams = { horizon: 1 }
  if (newType === 'strategy_aware') defaultParams = { max_hold_days: 20 }
  emit('update:modelValue', { base_type: newType, base_params: defaultParams })
}

function onHorizonChange(v: number | null) {
  emit('update:modelValue', {
    ...props.modelValue,
    base_params: { ...props.modelValue.base_params, horizon: v ?? 1 },
  })
}

function onMaxHoldDaysChange(v: number | null) {
  emit('update:modelValue', {
    ...props.modelValue,
    base_params: { ...props.modelValue.base_params, max_hold_days: v ?? 20 },
  })
}
</script>

<style scoped>
.base-type-fields {
  display: contents;
}
.unit-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
}
</style>
