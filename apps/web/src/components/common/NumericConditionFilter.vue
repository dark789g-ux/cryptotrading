<template>
  <n-button @click="showModal = true">
    <template #icon><n-icon><filter-outline /></n-icon></template>
    {{ buttonLabel }}
    <n-badge v-if="conditions.length" :value="conditions.length" />
  </n-button>

  <n-modal
    v-model:show="showModal"
    preset="card"
    :title="title"
    class="numeric-condition-modal"
    :style="modalStyle"
  >
    <div v-if="description" class="filter-description">{{ description }}</div>

    <div class="condition-form">
      <div class="field-group">
        <label>字段</label>
        <n-select v-model:value="draft.field" :options="fieldOptions" filterable placeholder="选择字段" />
      </div>
      <div class="field-group field-group--compact">
        <label>关系</label>
        <n-select v-model:value="draft.op" :options="opOptions" placeholder="选择关系" />
      </div>
      <div class="field-group field-group--compact">
        <label>数值</label>
        <n-input-number v-model:value="draft.value" placeholder="输入数值" />
      </div>
      <n-button type="primary" :disabled="!canAddCondition" @click="addCondition">添加</n-button>
    </div>

    <n-divider />

    <div class="condition-section">
      <div class="condition-section-title">当前条件</div>
      <n-empty v-if="!conditions.length" class="condition-empty" :description="emptyDescription" />
      <div v-else class="condition-list">
        <div v-for="(condition, index) in conditions" :key="`${condition.field}-${condition.op}-${condition.value}-${index}`" class="condition-item">
          <span>{{ formatCondition(condition) }}</span>
          <n-button quaternary circle size="small" @click="removeCondition(index)">
            <template #icon><n-icon><close-outline /></n-icon></template>
          </n-button>
        </div>
      </div>
    </div>

    <template #footer>
      <div class="modal-actions">
        <n-button @click="clearConditions">清空条件</n-button>
        <n-button @click="showModal = false">取消</n-button>
        <n-button type="primary" @click="confirmConditions">确定</n-button>
      </div>
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { computed, ref } from 'vue'
import { NBadge, NButton, NDivider, NEmpty, NIcon, NInputNumber, NModal, NSelect } from 'naive-ui'
import { CloseOutline, FilterOutline } from '@vicons/ionicons5'
import type { NumericCondition, NumericConditionFieldOption } from './numericConditionFilterTypes'

const props = withDefaults(
  defineProps<{
    conditions: NumericCondition[]
    fieldOptions: NumericConditionFieldOption[]
    title?: string
    buttonLabel?: string
    description?: string
    emptyDescription?: string
  }>(),
  {
    title: '高级筛选',
    buttonLabel: '高级筛选',
    description: '',
    emptyDescription: '暂无条件',
  },
)

const emit = defineEmits<{
  'update:conditions': [value: NumericCondition[]]
  confirm: []
}>()

const showModal = ref(false)
const draft = ref<NumericCondition>({ field: '', op: 'gt', value: 0 })
const modalStyle = {
  width: 'min(480px, calc(100vw - 32px))',
} as const

const opOptions = [
  { label: '>', value: 'gt' },
  { label: '>=', value: 'gte' },
  { label: '<', value: 'lt' },
  { label: '<=', value: 'lte' },
  { label: '=', value: 'eq' },
  { label: '!=', value: 'neq' },
] satisfies Array<{ label: string; value: NumericCondition['op'] }>

const opLabels: Record<NumericCondition['op'], string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
}

const fieldLabelMap = computed(() => {
  const map = new Map<string, string>()
  const visit = (options: NumericConditionFieldOption[]) => {
    options.forEach((option) => {
      if (option.type === 'group') {
        visit((option.children ?? []) as NumericConditionFieldOption[])
        return
      }
      if (option.type === 'ignored') return
      if (typeof option.value === 'string' && typeof option.label === 'string') {
        map.set(option.value, option.label)
      }
    })
  }
  visit(props.fieldOptions)
  return map
})

const canAddCondition = computed(() => Boolean(draft.value.field) && Number.isFinite(Number(draft.value.value)))

function resetDraft() {
  draft.value = { field: '', op: 'gt', value: 0 }
}

function addCondition() {
  if (!canAddCondition.value) return
  emit('update:conditions', [...props.conditions, { ...draft.value, value: Number(draft.value.value) }])
  resetDraft()
}

function removeCondition(index: number) {
  emit(
    'update:conditions',
    props.conditions.filter((_, currentIndex) => currentIndex !== index),
  )
}

function clearConditions() {
  emit('update:conditions', [])
}

function confirmConditions() {
  showModal.value = false
  emit('confirm')
}

function formatCondition(condition: NumericCondition) {
  const fieldLabel = fieldLabelMap.value.get(condition.field) ?? condition.field
  return `${fieldLabel} ${opLabels[condition.op]} ${condition.value}`
}
</script>

<style scoped>
.filter-description { color: var(--color-text-secondary); margin-bottom: 14px; font-size: 13px; }
.condition-form { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; align-items: end; }
.field-group { display: flex; flex-direction: column; gap: 6px; }
.field-group:first-child { grid-column: 1 / -1; }
.field-group label { color: var(--color-text-secondary); font-size: 13px; }
.field-group--compact :deep(.n-input-number) { width: 100%; }
.condition-form > .n-button { justify-self: end; }
.condition-section-title { margin-bottom: 10px; font-size: 14px; font-weight: 700; }
.condition-empty { min-height: 96px; display: flex; align-items: center; justify-content: center; }
.condition-list { display: flex; flex-direction: column; gap: 8px; max-height: 220px; overflow-y: auto; padding-right: 2px; }
.condition-item { display: flex; justify-content: space-between; align-items: center; gap: 12px; padding: 8px 12px; background: var(--color-surface-elevated); border: 1px solid var(--color-border); border-radius: 8px; }
.modal-actions { display: flex; justify-content: flex-end; gap: 10px; }

@media (max-width: 560px) {
  .condition-form { grid-template-columns: 1fr; }
  .field-group:first-child { grid-column: auto; }
  .condition-form > .n-button { justify-self: stretch; }
}
</style>
