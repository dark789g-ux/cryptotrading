<template>
  <div class="classify-fields">
    <n-form-item label="分类方式">
      <n-select
        :value="modelValue.classify_mode"
        :options="classifyModeOptions"
        clearable
        placeholder="留空 = 连续/回归"
        data-testid="label-classify-mode-select"
        @update:value="onClassifyModeChange"
      />
    </n-form-item>

    <!-- band：横盘阈值 ε -->
    <n-form-item
      v-if="modelValue.classify_mode === 'band'"
      label="横盘阈值 ε"
      required
    >
      <n-input-number
        :value="bandEps"
        :min="0.001"
        :max="0.1"
        :step="0.001"
        :precision="3"
        placeholder="0.005"
        style="width: 180px;"
        data-testid="label-band-eps"
        @update:value="onEpsChange"
      >
        <template #suffix>
          ≈ {{ epsPercent }}%
        </template>
      </n-input-number>
      <span class="unit-hint">（涨跌幅绝对值 ≤ ε 记横盘）</span>
    </n-form-item>

    <!-- tercile：无额外字段，只显示说明 -->
    <div v-if="modelValue.classify_mode === 'tercile'" class="classify-hint">
      截面三分位：当日按涨跌幅高/中/低自动分三组，无额外参数
    </div>

    <!-- custom：分位边界输入 -->
    <template v-if="modelValue.classify_mode === 'custom'">
      <n-form-item label="下界分位（%）" required>
        <n-input-number
          :value="customLo"
          :min="1"
          :max="49"
          :step="1"
          placeholder="33"
          style="width: 180px;"
          data-testid="label-custom-lo"
          @update:value="onCustomLoChange"
        />
      </n-form-item>
      <n-form-item label="上界分位（%）" required>
        <n-input-number
          :value="customHi"
          :min="51"
          :max="99"
          :step="1"
          placeholder="67"
          style="width: 180px;"
          data-testid="label-custom-hi"
          @update:value="onCustomHiChange"
        />
      </n-form-item>
      <div class="classify-hint">
        下界分位 &lt; 上界分位；涨跌幅低于下界分位 → 看跌，高于上界分位 → 看涨，中间 → 横盘
      </div>
    </template>
  </div>
</template>

<script setup lang="ts">
import { computed } from 'vue'
import { NFormItem, NInputNumber, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'

export interface ClassifyModel {
  classify_mode: string | null
  classify_params: Record<string, unknown> | null
}

interface ClassifyModeOption extends SelectOption {
  label: string
  value: string | null
}

const props = defineProps<{ modelValue: ClassifyModel }>()
const emit = defineEmits<{ 'update:modelValue': [value: ClassifyModel] }>()

const classifyModeOptions: ClassifyModeOption[] = [
  { label: '连续/回归（不分类）', value: null },
  { label: 'band（固定阈值带）', value: 'band' },
  { label: 'tercile（截面三分位）', value: 'tercile' },
  { label: 'custom（自定义分位边界）', value: 'custom' },
]

const bandEps = computed<number | null>(() => {
  const v = props.modelValue.classify_params?.eps
  return typeof v === 'number' ? v : null
})

const epsPercent = computed(() =>
  ((bandEps.value ?? 0.005) * 100).toFixed(2),
)

const customLo = computed<number | null>(() => {
  const v = props.modelValue.classify_params?.lo_pct
  return typeof v === 'number' ? v : null
})

const customHi = computed<number | null>(() => {
  const v = props.modelValue.classify_params?.hi_pct
  return typeof v === 'number' ? v : null
})

function onClassifyModeChange(mode: string | null) {
  let defaultParams: Record<string, unknown> | null = null
  if (mode === 'band') defaultParams = { eps: 0.005 }
  if (mode === 'tercile') defaultParams = {}
  if (mode === 'custom') defaultParams = { lo_pct: 33, hi_pct: 67 }
  emit('update:modelValue', { classify_mode: mode, classify_params: defaultParams })
}

function onEpsChange(v: number | null) {
  emit('update:modelValue', {
    ...props.modelValue,
    classify_params: { ...props.modelValue.classify_params, eps: v ?? 0.005 },
  })
}

function onCustomLoChange(v: number | null) {
  emit('update:modelValue', {
    ...props.modelValue,
    classify_params: { ...props.modelValue.classify_params, lo_pct: v ?? 33 },
  })
}

function onCustomHiChange(v: number | null) {
  emit('update:modelValue', {
    ...props.modelValue,
    classify_params: { ...props.modelValue.classify_params, hi_pct: v ?? 67 },
  })
}
</script>

<style scoped>
.classify-fields {
  display: contents;
}
.unit-hint {
  margin-left: 8px;
  font-size: 12px;
  color: var(--color-text-muted);
}
.classify-hint {
  margin: -6px 0 12px 0;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-border) 16%, transparent);
  border-radius: 6px;
  border-left: 2px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
}
</style>
