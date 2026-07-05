<template>
  <n-card title="新建 Regime 回测" :bordered="false" size="small">
    <n-form ref="formRef" :model="form" :rules="rules" label-placement="left" label-width="100">
      <n-form-item label="Regime 配置" path="regimeConfigId">
        <n-select
          v-model:value="form.regimeConfigId"
          :options="configOptions"
          placeholder="选择配置版本"
          filterable
          style="width: 280px"
        />
      </n-form-item>
      <n-form-item label="方案名" path="name">
        <n-input v-model:value="form.name" placeholder="例：v3 现实成本回测" style="width: 280px" />
      </n-form-item>
      <n-form-item label="初始资金" path="initialCapital">
        <n-input-number
          v-model:value="form.initialCapital"
          :min="10000"
          :step="100000"
          style="width: 280px"
        />
      </n-form-item>
      <n-form-item label="仓位比例" path="positionRatio">
        <n-input-number
          v-model:value="form.positionRatio"
          :min="0.01"
          :max="1"
          :step="0.05"
          style="width: 280px"
        />
      </n-form-item>
      <n-form-item label="最大持仓数">
        <n-input-number
          v-model:value="form.maxPositions"
          :min="1"
          :step="1"
          placeholder="留空不限制"
          clearable
          style="width: 280px"
        />
      </n-form-item>
      <n-form-item label="成本预设">
        <n-select
          v-model:value="costTier"
          :options="costTierOptions"
          style="width: 280px"
        />
      </n-form-item>
      <n-form-item label="回测区间">
        <n-date-picker
          v-model:value="dateRange"
          type="daterange"
          clearable
          :is-date-disabled="isDateDisabled"
          style="width: 280px"
        />
      </n-form-item>
    </n-form>
    <template #action>
      <n-button type="primary" :loading="submitting" :disabled="!canSubmit" @click="emit('submit')">
        新建并运行
      </n-button>
    </template>
  </n-card>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import {
  NCard,
  NForm,
  NFormItem,
  NInput,
  NInputNumber,
  NSelect,
  NDatePicker,
  NButton,
  type FormRules,
  type FormInst,
} from 'naive-ui'
import type { RegimeStrategyConfig } from '@/api/modules/strategy/regimeEngine'
import type { RegimeBacktestCostRates } from '@/api/modules/strategy/regimeEngine'

const COST_TIER_PRESETS: Record<string, RegimeBacktestCostRates> = {
  optimistic: {
    commissionPerSide: 0.00025,
    transferPerSide: 0.00001,
    stampSellBefore20230828: 0.001,
    stampSellFrom20230828: 0.0005,
    slippagePerSide: 0,
  },
  realistic: {
    commissionPerSide: 0.00025,
    transferPerSide: 0.00001,
    stampSellBefore20230828: 0.001,
    stampSellFrom20230828: 0.0005,
    slippagePerSide: 0.0005,
  },
  conservative: {
    commissionPerSide: 0.00025,
    transferPerSide: 0.00001,
    stampSellBefore20230828: 0.001,
    stampSellFrom20230828: 0.0005,
    slippagePerSide: 0.001,
  },
  zero: {
    commissionPerSide: 0,
    transferPerSide: 0,
    stampSellBefore20230828: 0,
    stampSellFrom20230828: 0,
    slippagePerSide: 0,
  },
}

const COST_TIER_OPTIONS = [
  { label: '乐观（滑点 0）', value: 'optimistic' },
  { label: '现实（滑点万5）', value: 'realistic' },
  { label: '保守（滑点千1）', value: 'conservative' },
  { label: '零成本（对账用）', value: 'zero' },
]

const props = defineProps<{
  configs: RegimeStrategyConfig[]
  submitting: boolean
}>()

const emit = defineEmits<{
  submit: []
}>()

const formRef = ref<FormInst | null>(null)

const form = ref({
  regimeConfigId: null as string | null,
  name: '',
  initialCapital: 1000000,
  positionRatio: 0.25,
  maxPositions: null as number | null,
})

const costTier = ref('realistic')
const dateRange = ref<[number, number] | null>(null)

const configOptions = computed(() =>
  props.configs.map((c) => ({
    label: `v${c.version}${c.note ? ` ${c.note}` : ''}`,
    value: c.id,
  })),
)

const costTierOptions = COST_TIER_OPTIONS

const rules: FormRules = {
  regimeConfigId: { required: true, message: '请选择配置', trigger: 'change' },
  name: { required: true, message: '请输入方案名', trigger: 'blur' },
  initialCapital: { required: true, type: 'number', min: 10000, message: '最低 1 万', trigger: 'blur' },
  positionRatio: { required: true, type: 'number', min: 0.01, max: 1, message: '0~1', trigger: 'blur' },
}

const canSubmit = computed(() => {
  return (
    form.value.regimeConfigId !== null &&
    form.value.name.trim() !== '' &&
    dateRange.value !== null &&
    form.value.initialCapital >= 10000
  )
})

function todayLocalMs(): number {
  const d = new Date()
  return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
}

function isDateDisabled(ts: number): boolean {
  return ts > todayLocalMs()
}

function msToTradeDate(ms: number): string {
  const d = new Date(ms)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${y}${m}${day}`
}

watch(costTier, () => {})

function getFormData() {
  const tier = costTier.value
  const cost = COST_TIER_PRESETS[tier] ?? COST_TIER_PRESETS.realistic
  return {
    regimeConfigId: form.value.regimeConfigId!,
    name: form.value.name.trim(),
    capital: {
      initialCapital: form.value.initialCapital,
      cost,
      positionRatio: form.value.positionRatio,
      maxPositions: form.value.maxPositions,
    },
    dateStart: dateRange.value ? msToTradeDate(dateRange.value[0]) : '',
    dateEnd: dateRange.value ? msToTradeDate(dateRange.value[1]) : '',
  }
}

defineExpose({ getFormData, formRef })
</script>
