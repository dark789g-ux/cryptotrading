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
      <n-radio-group
        :value="priceMode"
        size="small"
        class="price-mode-group"
        @update:value="emit('update:priceMode', $event)"
      >
        <n-radio-button value="qfq">前复权</n-radio-button>
        <n-radio-button value="raw">原始价</n-radio-button>
      </n-radio-group>
      <div class="filter-actions">
        <n-button @click="emit('reset')">重置</n-button>
        <numeric-condition-filter
          :conditions="advancedConditions"
          :field-options="advancedFieldOptions"
          title="高级筛选"
          button-label="高级筛选"
          description="使用最新交易日的技术指标和估值指标筛选 A 股标的。"
          @update:conditions="emit('update:advancedConditions', $event)"
        />
        <n-button type="primary" @click="emit('apply')">应用</n-button>
      </div>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { NButton, NCard, NIcon, NInput, NInputNumber, NRadioButton, NRadioGroup, NSelect } from 'naive-ui'
import { SearchOutline } from '@vicons/ionicons5'
import NumericConditionFilter from '../../common/NumericConditionFilter.vue'
import type { NumericConditionFieldOption } from '../../common/numericConditionFilterTypes'
import type { Condition, SelectOption } from './types'

defineProps<{
  searchQuery: string
  selectedMarket: string | null
  selectedIndustry: string | null
  priceMode: 'qfq' | 'raw'
  pctChangeMin: number | null
  turnoverRateMin: number | null
  advancedConditions: Condition[]
  marketOptions: SelectOption[]
  industryOptions: SelectOption[]
}>()

const emit = defineEmits<{
  'update:searchQuery': [value: string]
  'update:selectedMarket': [value: string | null]
  'update:selectedIndustry': [value: string | null]
  'update:priceMode': [value: 'qfq' | 'raw']
  'update:pctChangeMin': [value: number | null]
  'update:turnoverRateMin': [value: number | null]
  'update:advancedConditions': [value: Condition[]]
  apply: []
  reset: []
}>()

const advancedFieldOptions: NumericConditionFieldOption[] = [
  {
    type: 'group',
    label: '均线',
    key: 'ma',
    children: [
      { label: 'MA5', value: 'MA5' },
      { label: 'MA30', value: 'MA30' },
      { label: 'MA60', value: 'MA60' },
      { label: 'MA120', value: 'MA120' },
      { label: 'MA240', value: 'MA240' },
    ],
  },
  {
    type: 'group',
    label: 'KDJ',
    key: 'kdj',
    children: [
      { label: 'KDJ.K', value: 'KDJ.K' },
      { label: 'KDJ.D', value: 'KDJ.D' },
      { label: 'KDJ.J', value: 'KDJ.J' },
    ],
  },
  {
    type: 'group',
    label: 'MACD',
    key: 'macd',
    children: [
      { label: 'DIF', value: 'DIF' },
      { label: 'DEA', value: 'DEA' },
      { label: 'MACD', value: 'MACD' },
    ],
  },
  {
    type: 'group',
    label: '成交与估值',
    key: 'valuation',
    children: [
      { label: '量比', value: 'volumeRatio' },
      { label: 'PE', value: 'pe' },
      { label: 'PB', value: 'pb' },
    ],
  },
]
</script>

<style scoped>
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.search-input { width: 200px; }
.filter-select { width: 140px; }
.filter-number { width: 130px; }
.price-mode-group { flex-shrink: 0; }
.filter-actions { margin-left: auto; display: flex; gap: 10px; align-items: center; }

@media (max-width: 960px) {
  .search-input,
  .filter-select,
  .filter-number,
  .price-mode-group,
  .filter-actions { width: 100%; }
  .filter-actions { margin-left: 0; justify-content: flex-end; }
}
</style>
