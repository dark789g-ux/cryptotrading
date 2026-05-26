<template>
  <n-card :bordered="false">
    <div class="filter-row">
      <n-input
        :value="searchQuery"
        placeholder="搜索行业"
        clearable
        class="search-input"
        @update:value="emit('update:searchQuery', $event)"
        @keyup.enter="emit('apply')"
      >
        <template #prefix><n-icon><search-outline /></n-icon></template>
      </n-input>
      <n-input-number
        :value="pctChangeMin"
        placeholder="涨跌幅% >="
        clearable
        class="filter-number"
        @update:value="emit('update:pctChangeMin', $event)"
      />
      <n-input-number
        :value="pctChangeMax"
        placeholder="涨跌幅% <="
        clearable
        class="filter-number"
        @update:value="emit('update:pctChangeMax', $event)"
      />
      <n-input-number
        :value="netAmountMin"
        placeholder="净流入(亿) >="
        clearable
        class="filter-number"
        @update:value="emit('update:netAmountMin', $event)"
      />
      <n-input-number
        :value="netBuyAmountMin"
        placeholder="净买入(亿) >="
        clearable
        class="filter-number"
        @update:value="emit('update:netBuyAmountMin', $event)"
      />
      <n-input-number
        :value="netSellAmountMin"
        placeholder="净卖出(亿) >="
        clearable
        class="filter-number"
        @update:value="emit('update:netSellAmountMin', $event)"
      />
      <div class="filter-actions">
        <n-button @click="showAdvanced = true">
          <template #icon><n-icon><filter-outline /></n-icon></template>
          高级筛选<span v-if="advancedConditions.length">（{{ advancedConditions.length }}）</span>
        </n-button>
        <n-button @click="emit('reset')">重置</n-button>
        <n-button type="primary" @click="emit('apply')">应用</n-button>
      </div>
    </div>

    <app-modal
      :show="showAdvanced"
      title="资金流向高级筛选"
      description="叠加多条件筛选行业资金流向。金额（净流入/净买入/净卖出）单位为「亿」，提交时自动换算为「万元」。"
      width="min(640px, 92vw)"
      @update:show="showAdvanced = $event"
    >
      <numeric-condition-filter
        :conditions="advancedConditions"
        :field-options="advancedFieldOptions"
        title="资金流向高级筛选"
        button-label="编辑高级筛选"
        description="支持「数值」与「字段」两种右值。"
        @update:conditions="onAdvancedChange"
      />
      <template #actions>
        <n-button @click="showAdvanced = false">关闭</n-button>
      </template>
    </app-modal>
  </n-card>
</template>

<script setup lang="ts">
import { ref } from 'vue'
import { NButton, NCard, NIcon, NInput, NInputNumber } from 'naive-ui'
import { FilterOutline, SearchOutline } from '@vicons/ionicons5'
import AppModal from '@/components/common/AppModal.vue'
import NumericConditionFilter from '@/components/common/NumericConditionFilter.vue'
import type { NumericCondition, NumericConditionFieldOption } from '@/components/common/numericConditionFilterTypes'

defineProps<{
  searchQuery: string
  pctChangeMin: number | null
  pctChangeMax: number | null
  netAmountMin: number | null
  netBuyAmountMin: number | null
  netSellAmountMin: number | null
  advancedConditions: NumericCondition[]
}>()

const emit = defineEmits<{
  'update:searchQuery': [value: string]
  'update:pctChangeMin': [value: number | null]
  'update:pctChangeMax': [value: number | null]
  'update:netAmountMin': [value: number | null]
  'update:netBuyAmountMin': [value: number | null]
  'update:netSellAmountMin': [value: number | null]
  'update:advancedConditions': [value: NumericCondition[]]
  apply: []
  reset: []
}>()

const showAdvanced = ref(false)

function onAdvancedChange(value: NumericCondition[]) {
  emit('update:advancedConditions', value)
}

const advancedFieldOptions: NumericConditionFieldOption[] = [
  {
    type: 'group',
    label: '资金流向',
    key: 'money-flow',
    children: [
      { label: '涨跌幅 %', value: 'pct_change' },
      { label: '净流入 (亿)', value: 'net_amount' },
      { label: '净买入 (亿)', value: 'net_buy_amount' },
      { label: '净卖出 (亿)', value: 'net_sell_amount' },
    ],
  },
]
</script>

<style scoped>
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.search-input { width: 200px; }
.filter-number { width: 140px; }
.filter-actions { margin-left: auto; display: flex; gap: 10px; align-items: center; }

@media (max-width: 960px) {
  .search-input,
  .filter-number,
  .filter-actions { width: 100%; }
  .filter-actions { margin-left: 0; justify-content: flex-end; }
}
</style>
