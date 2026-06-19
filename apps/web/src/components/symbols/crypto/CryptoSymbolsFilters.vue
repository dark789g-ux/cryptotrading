<template>
  <n-card :bordered="false">
    <div class="filter-row">
      <n-input
        :value="searchQuery"
        placeholder="Search symbol..."
        clearable
        class="search-input"
        @update:value="emit('update:searchQuery', $event)"
        @keyup.enter="emit('apply')"
      >
        <template #prefix><n-icon><search-outline /></n-icon></template>
      </n-input>
      <n-select
        :value="selectedWatchlistIds"
        :options="watchlistOptions"
        multiple
        filterable
        placeholder="标签"
        clearable
        class="filter-select"
        @update:value="handleWatchlistChange"
      />
      <n-select
        :value="selectedStrategyIds"
        :options="strategyOptions"
        multiple
        filterable
        placeholder="策略命中"
        clearable
        class="filter-select"
        @update:value="handleStrategyChange"
      />
      <div class="filter-actions">
        <n-button @click="emit('reset')">Reset</n-button>
        <numeric-condition-filter
          :conditions="conditions"
          :field-options="fieldOptions"
          title="Filters"
          button-label="Filters"
          description="Use latest kline indicators to filter symbols."
          empty-description="No conditions"
          @update:conditions="emit('update:conditions', $event)"
        />
        <n-button type="primary" @click="emit('apply')">Apply</n-button>
      </div>
    </div>
    <div v-if="conditions.length" class="filter-tags">
      <n-tag v-for="(cond, index) in conditions" :key="conditionKey(cond, index)" closable @close="removeCondition(index)">
        {{ formatConditionTag(cond) }}
      </n-tag>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { NButton, NCard, NIcon, NInput, NSelect, NTag } from 'naive-ui'
import { SearchOutline } from '@vicons/ionicons5'
import NumericConditionFilter from '../../common/NumericConditionFilter.vue'
import type { NumericCondition, NumericConditionFieldOption } from '../../common/numericConditionFilterTypes'
import type { Condition, SelectOption } from './types'

const props = defineProps<{
  searchQuery: string
  selectedWatchlistIds: string[]
  selectedStrategyIds: string[]
  conditions: Condition[]
  watchlistOptions: SelectOption[]
  strategyOptions: SelectOption[]
  fieldOptions: NumericConditionFieldOption[]
}>()

const emit = defineEmits<{
  'update:searchQuery': [value: string]
  'update:selectedWatchlistIds': [value: string[]]
  'update:selectedStrategyIds': [value: string[]]
  'update:conditions': [value: Condition[]]
  apply: []
  reset: []
}>()

const opLabels: Record<NumericCondition['op'], string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
}

function handleWatchlistChange(value: string[]) {
  emit('update:selectedWatchlistIds', value)
}

function handleStrategyChange(value: string[]) {
  emit('update:selectedStrategyIds', value)
}

function removeCondition(index: number) {
  emit(
    'update:conditions',
    props.conditions.filter((_, currentIndex) => currentIndex !== index),
  )
}

const formatConditionTag = (condition: NumericCondition) => {
  const rightValue = condition.valueType === 'field' ? condition.compareField : condition.value
  return `${condition.field} ${opLabels[condition.op]} ${rightValue}`
}

function conditionKey(condition: NumericCondition, index: number) {
  const rightValue = condition.valueType === 'field' ? condition.compareField : condition.value
  return `${condition.field}-${condition.op}-${condition.valueType ?? 'number'}-${rightValue}-${index}`
}
</script>

<style scoped>
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.search-input { width: 200px; }
.filter-select { width: 200px; }
.filter-actions { display: flex; gap: 10px; align-items: center; }
.filter-tags { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }

@media (max-width: 960px) {
  .search-input,
  .filter-select,
  .filter-actions { width: 100%; }
  .filter-actions { justify-content: flex-end; }
}
</style>
