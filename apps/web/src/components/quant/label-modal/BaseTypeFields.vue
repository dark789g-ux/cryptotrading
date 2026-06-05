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

    <!-- strategy_aware：引用一条 enabled 的出场策略 -->
    <n-form-item
      v-if="modelValue.base_type === 'strategy_aware'"
      label="引用策略"
      required
    >
      <n-select
        :value="strategyKey"
        :options="strategyOptions"
        :loading="strategiesLoading"
        placeholder="选择一条出场策略"
        style="width: 320px;"
        data-testid="label-strategy-ref"
        @update:value="onStrategyChange"
      />
      <span class="unit-hint">仅列启用的策略</span>
    </n-form-item>
    <div
      v-if="modelValue.base_type === 'strategy_aware' && strategyError"
      class="strategy-error"
    >
      {{ strategyError }}
    </div>
  </div>
</template>

<script setup lang="ts">
import { computed, ref, watch } from 'vue'
import { NFormItem, NInputNumber, NSelect } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { quantApi } from '@/api/modules/quant'
import type { StrategyDefinition } from '@cryptotrading/shared-types'

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

// ---- 策略选择器 ----
const strategies = ref<StrategyDefinition[]>([])
const strategiesLoading = ref(false)
const strategyError = ref('')

/** n-select 的 value 用 `id@version` 编码，便于在选项里唯一标识 */
const strategyKey = computed<string | null>(() => {
  const id = props.modelValue.base_params?.strategy_id
  const ver = props.modelValue.base_params?.strategy_version
  if (typeof id === 'string' && typeof ver === 'string') return `${id}@${ver}`
  return null
})

const strategyOptions = computed<SelectOption[]>(() =>
  strategies.value.map((s) => ({
    label: `${s.name} (${s.strategy_id}@${s.strategy_version})`,
    value: `${s.strategy_id}@${s.strategy_version}`,
  })),
)

async function loadStrategies() {
  strategiesLoading.value = true
  strategyError.value = ''
  try {
    const res = await quantApi.listStrategies({ enabled: true })
    strategies.value = res.items ?? []
    if (strategies.value.length === 0) {
      strategyError.value = '暂无启用的策略，请先到「策略管理」新建并启用'
    }
  } catch (e) {
    strategyError.value = `加载策略列表失败：${(e as Error).message}`
    strategies.value = []
  } finally {
    strategiesLoading.value = false
  }
}

// 切到 strategy_aware 时按需加载（避免 fwd_ret 标签也拉策略）
watch(
  () => props.modelValue.base_type,
  (t) => {
    if (t === 'strategy_aware' && strategies.value.length === 0 && !strategiesLoading.value) {
      loadStrategies()
    }
  },
  { immediate: true },
)

function onBaseTypeChange(newType: string) {
  // 切 base_type 时重置 base_params 为对应类型的空值
  let defaultParams: Record<string, unknown> = {}
  if (newType === 'fwd_ret') defaultParams = { horizon: 1 }
  // strategy_aware 切入时 base_params 置空待选（不预填）
  if (newType === 'strategy_aware') defaultParams = {}
  emit('update:modelValue', { base_type: newType, base_params: defaultParams })
}

function onHorizonChange(v: number | null) {
  emit('update:modelValue', {
    ...props.modelValue,
    base_params: { ...props.modelValue.base_params, horizon: v ?? 1 },
  })
}

function onStrategyChange(key: string) {
  const s = strategies.value.find((x) => `${x.strategy_id}@${x.strategy_version}` === key)
  if (!s) return
  emit('update:modelValue', {
    ...props.modelValue,
    base_params: { strategy_id: s.strategy_id, strategy_version: s.strategy_version },
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
.strategy-error {
  margin: -6px 0 12px 124px;
  font-size: 12px;
  color: var(--color-warning, #d97706);
}
</style>
