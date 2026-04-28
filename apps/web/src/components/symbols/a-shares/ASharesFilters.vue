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
      <div
        class="price-mode-toggle"
        role="radiogroup"
        aria-label="价格口径"
      >
        <button
          type="button"
          role="radio"
          :aria-checked="priceMode === 'qfq'"
          class="price-mode-toggle__btn"
          :class="{ 'price-mode-toggle__btn--active': priceMode === 'qfq' }"
          @click="emit('update:priceMode', 'qfq')"
        >
          前复权
        </button>
        <button
          type="button"
          role="radio"
          :aria-checked="priceMode === 'raw'"
          class="price-mode-toggle__btn"
          :class="{ 'price-mode-toggle__btn--active': priceMode === 'raw' }"
          @click="emit('update:priceMode', 'raw')"
        >
          原始价
        </button>
      </div>
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
        <a-shares-filter-preset-picker
          :presets="filterPresets"
          :loading="filterPresetsLoading"
          @refresh="emit('refreshFilterPresets')"
          @create="emit('createFilterPreset', $event)"
          @load="emit('applyFilterPreset', $event)"
          @overwrite="emit('overwriteFilterPreset', $event)"
          @rename="emit('renameFilterPreset', $event.preset, $event.name)"
          @delete="emit('deleteFilterPreset', $event)"
        />
        <n-button type="primary" @click="emit('apply')">应用</n-button>
      </div>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { NButton, NCard, NIcon, NInput, NInputNumber, NSelect } from 'naive-ui'
import { SearchOutline } from '@vicons/ionicons5'
import type { AShareFilterPreset } from '@/api'
import NumericConditionFilter from '../../common/NumericConditionFilter.vue'
import type { NumericConditionFieldOption } from '../../common/numericConditionFilterTypes'
import ASharesFilterPresetPicker from './ASharesFilterPresetPicker.vue'
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
  filterPresets: AShareFilterPreset[]
  filterPresetsLoading: boolean
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
  refreshFilterPresets: []
  createFilterPreset: [name: string]
  overwriteFilterPreset: [preset: AShareFilterPreset]
  renameFilterPreset: [preset: AShareFilterPreset, name: string]
  deleteFilterPreset: [preset: AShareFilterPreset]
  applyFilterPreset: [preset: AShareFilterPreset]
}>()

const advancedFieldOptions: NumericConditionFieldOption[] = [
  {
    type: 'group',
    label: '行情',
    key: 'quote',
    children: [
      { label: '开盘价', value: 'open' },
      { label: '最高价', value: 'high' },
      { label: '最低价', value: 'low' },
      { label: '最新价/收盘价', value: 'close' },
      { label: '涨跌额', value: 'change' },
      { label: '涨跌幅', value: 'pctChg' },
    ],
  },
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
      { label: '成交量', value: 'volume' },
      { label: '成交额', value: 'amount' },
      { label: '量比', value: 'volumeRatio' },
      { label: 'PE', value: 'pe' },
      { label: 'PE(TTM)', value: 'peTtm' },
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
.price-mode-toggle {
  display: inline-flex;
  flex-shrink: 0;
  height: 34px;
  padding: 2px;
  border: 1px solid var(--color-border);
  border-radius: 6px;
  background: var(--color-surface);
  box-sizing: border-box;
}
.price-mode-toggle__btn {
  margin: 0;
  padding: 0 12px;
  border: none;
  border-radius: 4px;
  background: transparent;
  font: inherit;
  font-size: 13px;
  font-weight: 600;
  color: var(--color-text-secondary);
  cursor: pointer;
  transition: background-color 0.15s ease, color 0.15s ease, box-shadow 0.15s ease;
}
.price-mode-toggle__btn:hover:not(.price-mode-toggle__btn--active) {
  color: var(--color-text);
}
.price-mode-toggle__btn:focus-visible {
  outline: 2px solid var(--color-primary);
  outline-offset: 1px;
}
.price-mode-toggle__btn:first-child {
  border-right: 1px solid color-mix(in srgb, var(--color-border) 70%, transparent);
}
.price-mode-toggle__btn--active {
  background: var(--color-surface-elevated);
  color: var(--color-text);
  box-shadow: 0 0 0 1px color-mix(in srgb, var(--color-border) 85%, transparent);
}
.filter-actions { margin-left: auto; display: flex; gap: 10px; align-items: center; }

@media (max-width: 960px) {
  .search-input,
  .filter-select,
  .filter-number,
  .price-mode-toggle,
  .filter-actions { width: 100%; }
  .filter-actions { margin-left: 0; justify-content: flex-end; }
}
</style>
