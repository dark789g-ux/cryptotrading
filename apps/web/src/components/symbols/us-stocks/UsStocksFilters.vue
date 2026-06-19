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
        :value="selectedTheme"
        :options="themeOptions"
        placeholder="主题"
        clearable
        filterable
        class="filter-select"
        @update:value="emit('update:selectedTheme', $event)"
      />
      <n-select
        :value="selectedStockType"
        :options="stockTypeOptions"
        placeholder="类型"
        clearable
        class="filter-select"
        @update:value="emit('update:selectedStockType', $event)"
      />
      <n-input-number
        :value="pctChangeMin"
        placeholder="涨跌幅 >="
        clearable
        class="filter-number"
        @update:value="emit('update:pctChangeMin', $event)"
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
          不复权
        </button>
      </div>
      <div class="filter-actions">
        <n-button secondary @click="emit('update:showColumnSettings', true)">
          <template #icon>
            <n-icon><settings-outline /></n-icon>
          </template>
          列设置
        </n-button>
        <n-button @click="emit('reset')">重置</n-button>
        <numeric-condition-filter
          :conditions="advancedConditions"
          :field-options="advancedFieldOptions"
          title="高级筛选"
          button-label="高级筛选"
          description="使用最新交易日的技术指标筛选美股标的。"
          @update:conditions="emit('update:advancedConditions', $event)"
        />
        <n-button type="primary" @click="emit('apply')">应用</n-button>
      </div>
    </div>
  </n-card>
</template>

<script setup lang="ts">
import { NButton, NCard, NIcon, NInput, NInputNumber, NSelect } from 'naive-ui'
import { SearchOutline, SettingsOutline } from '@vicons/ionicons5'
import NumericConditionFilter from '../../common/NumericConditionFilter.vue'
import type { NumericConditionFieldOption } from '../../common/numericConditionFilterTypes'
import type { Condition, SelectOption } from './types'

defineProps<{
  searchQuery: string
  selectedTheme: string | null
  selectedStockType: string | null
  priceMode: 'qfq' | 'raw'
  pctChangeMin: number | null
  advancedConditions: Condition[]
  themeOptions: SelectOption[]
  stockTypeOptions: SelectOption[]
}>()

const emit = defineEmits<{
  'update:searchQuery': [value: string]
  'update:selectedTheme': [value: string | null]
  'update:selectedStockType': [value: string | null]
  'update:priceMode': [value: 'qfq' | 'raw']
  'update:pctChangeMin': [value: number | null]
  'update:advancedConditions': [value: Condition[]]
  apply: []
  reset: []
  'update:showColumnSettings': [value: boolean]
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
      { label: '成交量', value: 'volume' },
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
      { label: 'BBI', value: 'BBI', descKey: 'bbi' },
    ],
  },
  {
    type: 'group',
    label: 'KDJ',
    key: 'kdj',
    children: [
      { label: 'KDJ.K', value: 'KDJ.K', descKey: 'kdj_k' },
      { label: 'KDJ.D', value: 'KDJ.D', descKey: 'kdj_d' },
      { label: 'KDJ.J', value: 'KDJ.J', descKey: 'kdj_j' },
    ],
  },
  {
    type: 'group',
    label: 'MACD',
    key: 'macd',
    children: [
      { label: 'DIF', value: 'DIF', descKey: 'macd_dif' },
      { label: 'DEA', value: 'DEA', descKey: 'macd_dea' },
      { label: 'MACD', value: 'MACD', descKey: 'macd_hist' },
    ],
  },
  {
    type: 'group',
    label: '风控 / 波动',
    key: 'risk',
    children: [
      { label: 'ATR14', value: 'atr14', descKey: 'atr14' },
      { label: 'Loss ATR14', value: 'lossAtr14', descKey: 'loss_atr14' },
      { label: 'RR', value: 'riskRewardRatio', descKey: 'profit_loss_ratio' },
      { label: 'Stop %', value: 'stopLossPct', descKey: 'stop_loss_pct' },
    ],
  },
]
</script>

<style scoped>
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.search-input { width: 200px; }
.filter-select { width: 150px; }
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
