<!-- apps/web/src/components/money-flow/IndustryFlowPanel.vue -->
<template>
  <div class="industry-flow-panel">
    <div class="panel-controls">
      <FlowDateControl :default-date="latestDate" @change="onDateChange" />
    </div>

    <IndustryFilters
      v-model:search-query="searchQuery"
      v-model:pct-change-min="pctChangeMin"
      v-model:pct-change-max="pctChangeMax"
      v-model:net-amount-min="netAmountMin"
      v-model:net-buy-amount-min="netBuyAmountMin"
      v-model:net-sell-amount-min="netSellAmountMin"
      v-model:advanced-conditions="advancedConditions"
      @apply="onApply"
      @reset="onReset"
    />

    <div class="panel-body">
      <div class="table-col">
        <n-data-table
          :columns="columns"
          :data="rows"
          :loading="loading"
          :max-height="500"
          size="small"
          :pagination="{ pageSize: 50 }"
        />
        <div v-if="!loading && !rows.length" class="empty-state">
          暂无数据，请前往
          <router-link to="/sync">数据同步</router-link>
          页面更新资金流向数据。
        </div>
      </div>
    </div>

    <FlowTrendModal
      v-model:visible="trendVisible"
      :ts-code="trendTsCode"
      :entity-name="trendEntityName"
      :fetch-fn="trendFetchFn"
      chart-mode="kline"
      :show-members-tab="true"
      :members-trade-date="trendMembersTradeDate"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'IndustryFlowPanel' })

import { h, onActivated, onMounted, ref } from 'vue'
import { NButton, NDataTable } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { moneyFlowApi, type MoneyFlowCondition, type MoneyFlowQueryParams, type MoneyFlowIndustryRow } from '@/api/modules/market/moneyFlow'
import FlowDateControl from './FlowDateControl.vue'
import FlowTrendModal from './FlowTrendModal.vue'
import IndustryFilters from './IndustryFilters.vue'
import { fetchIndustryTrend } from './trendFetchers'
import type { NumericCondition } from '@/components/common/numericConditionFilterTypes'

const rows = ref<MoneyFlowIndustryRow[]>([])
const loading = ref(false)
const currentParams = ref<MoneyFlowQueryParams>({})
const latestDate = ref<string | null>(null)

// 日期参数（来自 FlowDateControl）独立保存，应用时与筛选合并
const dateParams = ref<MoneyFlowQueryParams>({})

// 筛选状态
const searchQuery = ref('')
const pctChangeMin = ref<number | null>(null)
const pctChangeMax = ref<number | null>(null)
const netAmountMin = ref<number | null>(null)
const netBuyAmountMin = ref<number | null>(null)
const netSellAmountMin = ref<number | null>(null)
const advancedConditions = ref<NumericCondition[]>([])

const trendVisible = ref(false)
const trendTsCode = ref('')
const trendEntityName = ref('')
const trendMembersTradeDate = ref<string | null>(null)

// 金额字段集合：前端按"亿"收集，传 API 前 × 1e4 转"万元"
const AMOUNT_FIELDS = new Set(['net_amount', 'net_buy_amount', 'net_sell_amount'])
const YI_TO_WAN = 1e4

function openDetail(row: MoneyFlowIndustryRow) {
  trendTsCode.value = row.tsCode
  trendEntityName.value = row.industry
  trendMembersTradeDate.value = currentParams.value.trade_date ?? latestDate.value
  trendVisible.value = true
}

const trendFetchFn = fetchIndustryTrend

const columns: DataTableColumns<MoneyFlowIndustryRow> = [
  { title: '行业', key: 'industry', width: 120 },
  { title: '涨跌幅%', key: 'pctChange', width: 90, sorter: (a, b) => Number(a.pctChange) - Number(b.pctChange), render: row => { const v = Number(row.pctChange); return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`) } },
  { title: '净流入(亿)', key: 'netAmount', width: 110, defaultSortOrder: 'descend' as const, sorter: (a, b) => Number(a.netAmount) - Number(b.netAmount), render: row => { const v = Number(row.netAmount); return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2)) } },
  { title: '净买入(亿)', key: 'netBuyAmount', width: 110, sorter: (a, b) => Number(a.netBuyAmount) - Number(b.netBuyAmount), render: row => { const v = Number(row.netBuyAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
  { title: '净卖出(亿)', key: 'netSellAmount', width: 110, render: row => { const v = Number(row.netSellAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
  {
    title: '操作',
    key: 'action',
    width: 70,
    render: (row) => h(NButton, { text: true, type: 'primary', onClick: () => openDetail(row) }, () => '详情'),
  },
]

function buildFilterParams(): MoneyFlowQueryParams {
  const params: MoneyFlowQueryParams = { ...dateParams.value }
  const q = searchQuery.value.trim()
  if (q) params.industry = q
  if (pctChangeMin.value != null) params.pct_change_min = pctChangeMin.value
  if (pctChangeMax.value != null) params.pct_change_max = pctChangeMax.value
  if (netAmountMin.value != null) params.net_amount_min = netAmountMin.value * YI_TO_WAN
  if (netBuyAmountMin.value != null) params.net_buy_amount_min = netBuyAmountMin.value * YI_TO_WAN
  if (netSellAmountMin.value != null) params.net_sell_amount_min = netSellAmountMin.value * YI_TO_WAN
  if (advancedConditions.value.length) {
    params.conditions = advancedConditions.value.map((c): MoneyFlowCondition => {
      if (c.valueType === 'field') {
        return { field: c.field, op: c.op, valueType: 'field', compareField: c.compareField }
      }
      const needsConvert = AMOUNT_FIELDS.has(c.field)
      return {
        field: c.field,
        op: c.op,
        valueType: 'number',
        value: needsConvert ? c.value * YI_TO_WAN : c.value,
      }
    })
  }
  return params
}

async function load() {
  if (!currentParams.value.trade_date && !currentParams.value.start_date) return
  loading.value = true
  try {
    rows.value = await moneyFlowApi.queryIndustries(currentParams.value)
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  dateParams.value = params
  currentParams.value = buildFilterParams()
  load()
}

function onApply() {
  currentParams.value = buildFilterParams()
  load()
}

function onReset() {
  searchQuery.value = ''
  pctChangeMin.value = null
  pctChangeMax.value = null
  netAmountMin.value = null
  netBuyAmountMin.value = null
  netSellAmountMin.value = null
  advancedConditions.value = []
  currentParams.value = buildFilterParams()
  load()
}

onMounted(async () => {
  try {
    const dates = await moneyFlowApi.getLatestDates()
    latestDate.value = dates.industry
  } catch { /* ignore */ }
})

onActivated(load)
</script>

<style scoped>
.industry-flow-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-controls { display: flex; align-items: center; gap: 16px; }
.panel-body { display: flex; flex-direction: column; }
.table-col { min-width: 0; }
.empty-state { color: var(--color-text-muted); text-align: center; padding: 40px; }
.empty-state a { color: var(--color-primary); }
:deep(.positive) { color: #f04747; }
:deep(.negative) { color: #4caf8a; }
</style>
