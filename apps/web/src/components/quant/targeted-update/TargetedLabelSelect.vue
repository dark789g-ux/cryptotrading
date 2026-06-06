<template>
  <div class="label-select">
    <n-form-item label="命名标签">
      <n-select
        :value="modelValue"
        :options="labelOptions"
        :loading="loading"
        clearable
        placeholder="选择要重算的标签…"
        data-testid="targeted-label-select"
        @update:value="onUpdate"
      />
    </n-form-item>

    <div v-if="selectedSummary" class="label-summary">
      {{ selectedSummary }}
    </div>

    <n-alert
      v-if="modelValue"
      type="warning"
      style="margin-bottom: 8px;"
      :show-icon="true"
    >
      <template #default>
        <strong>标签闭合窗口提醒：</strong>
        strategy-aware / fwd_ret 类标签以入场日 T 为准，出场数据需 T 之后约
        <strong>20 个交易日</strong>的未来数据才能闭合。
        请确保日期终点不过于接近今天，否则最近的标签行将<strong>未闭合</strong>或包含错误值。
      </template>
    </n-alert>
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import { NAlert, NFormItem, NSelect, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import { quantApi, type LabelDefinition } from '@/api/modules/quant'

interface LabelOption extends SelectOption {
  label: string
  value: string
  def: LabelDefinition
}

/**
 * modelValue = "label_id:label_version" 形式的 key，或 null。
 */
const props = defineProps<{
  modelValue: string | null
}>()

const emit = defineEmits<{
  'update:modelValue': [key: string | null]
}>()

const message = useMessage()
const loading = ref(false)
const labelDefs = ref<LabelDefinition[]>([])

function labelKey(d: LabelDefinition): string {
  return `${d.label_id}:${d.label_version}`
}

function buildSummary(d: LabelDefinition): string {
  const basePart = d.base_type === 'fwd_ret'
    ? `fwd_ret h${d.base_params?.horizon ?? '?'}`
    : d.base_type === 'strategy_aware'
      ? `strategy_aware mhd${d.base_params?.max_hold_days ?? '?'}`
      : d.base_type

  let clsPart = '连续'
  if (d.classify_mode === 'band') {
    const eps = d.classify_params?.eps
    clsPart = typeof eps === 'number' ? `band ${(eps * 100).toFixed(2)}%` : 'band'
  } else if (d.classify_mode === 'tercile') {
    clsPart = 'tercile'
  } else if (d.classify_mode === 'custom') {
    clsPart = `custom p${d.classify_params?.lo_pct ?? '?'}-p${d.classify_params?.hi_pct ?? '?'}`
  }
  return `${basePart} | ${clsPart}`
}

const labelOptions = computed<LabelOption[]>(() =>
  labelDefs.value.map((d) => ({
    label: `${d.name} (${d.label_version}) — ${buildSummary(d)}`,
    value: labelKey(d),
    def: d,
  })),
)

const selectedSummary = computed<string | null>(() => {
  if (!props.modelValue) return null
  const def = labelDefs.value.find((d) => labelKey(d) === props.modelValue)
  if (!def) return null
  return `${def.name}（${buildSummary(def)}）`
})

function onUpdate(key: string | null) {
  emit('update:modelValue', key)
}

async function loadLabels() {
  loading.value = true
  try {
    const res = await quantApi.listLabels({ enabled: true })
    labelDefs.value = res.items ?? []
  } catch {
    message.warning('获取标签列表失败，请检查后端连接')
  } finally {
    loading.value = false
  }
}

onMounted(() => {
  void loadLabels()
})
</script>

<style scoped>
.label-select {
  display: contents;
}
.label-summary {
  margin: -8px 0 12px 0;
  padding: 6px 10px;
  font-size: 12px;
  color: var(--color-text-muted);
  background: color-mix(in srgb, var(--color-border) 16%, transparent);
  border-radius: 6px;
  border-left: 2px solid color-mix(in srgb, var(--color-primary) 40%, transparent);
}
</style>
