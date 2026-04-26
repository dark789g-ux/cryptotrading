<template>
  <n-card :bordered="false">
    <div class="filter-row">
      <n-input
        :value="searchQuery"
        placeholder="搜索代码 / 名称"
        clearable
        class="search-input"
        @update:value="emit('update:searchQuery', $event)"
        @keyup.enter="emit('apply')"
      >
        <template #prefix><n-icon><search-outline /></n-icon></template>
      </n-input>
      <n-select
        :value="selectedMarket"
        :options="marketOptions"
        placeholder="市场"
        clearable
        class="filter-select"
        @update:value="emit('update:selectedMarket', $event)"
      />
      <n-select
        :value="selectedIndustry"
        :options="industryOptions"
        placeholder="行业"
        clearable
        filterable
        class="filter-select"
        @update:value="emit('update:selectedIndustry', $event)"
      />
      <n-input-number
        :value="pctChangeMin"
        placeholder="涨跌幅 >="
        clearable
        class="filter-number"
        @update:value="emit('update:pctChangeMin', $event)"
      />
      <n-input-number
        :value="turnoverRateMin"
        placeholder="换手率 >="
        clearable
        class="filter-number"
        @update:value="emit('update:turnoverRateMin', $event)"
      />
      <n-button @click="emit('reset')">重置</n-button>
      <n-button type="primary" @click="emit('apply')">应用</n-button>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { NButton, NCard, NIcon, NInput, NInputNumber, NSelect } from 'naive-ui'
import { SearchOutline } from '@vicons/ionicons5'
import type { SelectOption } from './types'

defineProps<{
  searchQuery: string
  selectedMarket: string | null
  selectedIndustry: string | null
  pctChangeMin: number | null
  turnoverRateMin: number | null
  marketOptions: SelectOption[]
  industryOptions: SelectOption[]
}>()

const emit = defineEmits<{
  'update:searchQuery': [value: string]
  'update:selectedMarket': [value: string | null]
  'update:selectedIndustry': [value: string | null]
  'update:pctChangeMin': [value: number | null]
  'update:turnoverRateMin': [value: number | null]
  apply: []
  reset: []
}>()
</script>

<style scoped>
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.search-input { width: 200px; }
.filter-select { width: 140px; }
.filter-number { width: 130px; }

@media (max-width: 960px) {
  .search-input,
  .filter-select,
  .filter-number { width: 100%; }
}
</style>
