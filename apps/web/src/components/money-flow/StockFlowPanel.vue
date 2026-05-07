<!-- apps/web/src/components/money-flow/StockFlowPanel.vue -->
<template>
  <div class="stock-flow-panel">
    <div class="panel-controls">
      <FlowDateControl @change="onDateChange" />
      <n-input
        v-model:value="searchQuery"
        placeholder="搜索股票代码/名称"
        clearable
        style="width: 200px"
      />
    </div>

    <FlowKpiCards :cards="kpiCards" :loading="loading" />

    <div class="panel-body">
      <div class="chart-col">
        <FlowBarChart :rows="chartRows" :max-rows="20" />
      </div>
      <div class="table-col">
        <n-data-table
          :columns="columns"
          :data="filteredRows"
          :loading="loading"
          :max-height="500"
          size="small"
          :pagination="{ pageSize: 50 }"
          :scroll-x="700"
        />
        <div v-if="!loading && !rows.length" class="empty-state">
          暂无数据，请前往
          <router-link to="/sync">数据同步</router-link>
          页面更新资金流向数据。
        </div>
      </div>
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'StockFlowPanel' })

import { computed, h, onActivated, ref } from 'vue'
import { NDataTable, NInput } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { moneyFlowApi, type MoneyFlowQueryParams, type MoneyFlowStockRow } from '@/api/modules/moneyFlow'
import FlowDateControl from './FlowDateControl.vue'
import FlowKpiCards from './FlowKpiCards.vue'
import FlowBarChart from './FlowBarChart.vue'
import type { KpiCardItem, BarChartRow } from './money-flow.types'

const rows = ref<MoneyFlowStockRow[]>([])
const loading = ref(false)
const searchQuery = ref('')
const currentParams = ref<MoneyFlowQueryParams>({})

const filteredRows = computed(() => {
  const q = searchQuery.value.trim().toLowerCase()
  if (!q) return rows.value
  return rows.value.filter(r =>
    r.tsCode.toLowerCase().includes(q) || (r.name ?? '').toLowerCase().includes(q),
  )
})

const kpiCards = computed((): KpiCardItem[] => {
  const sorted = [...rows.value].sort((a, b) => Number(b.netAmount) - Number(a.netAmount))
  const top1 = sorted[0]
  const topPct = [...rows.value].sort((a, b) => Number(b.pctChange) - Number(a.pctChange))[0]
  const topLg = [...rows.value].sort((a, b) => Number(b.buyLgAmount) - Number(a.buyLgAmount))[0]
  return [
    { label: '净流入最多', value: top1?.netAmount ?? null, sub: top1 ? `${top1.name}(${top1.tsCode})` : '' },
    { label: '涨幅最高', value: topPct?.pctChange ?? null, sub: topPct ? topPct.name ?? '' : '' },
    { label: '大单净流入', value: topLg?.buyLgAmount ?? null, sub: topLg ? topLg.name ?? '' : '' },
    { label: '上榜股票数', value: String(rows.value.length), sub: '当日' },
  ]
})

const chartRows = computed((): BarChartRow[] =>
  rows.value.map(r => ({ label: r.name ?? r.tsCode, value: Number(r.netAmount) || 0 })),
)

const columns: DataTableColumns<MoneyFlowStockRow> = [
  { title: '代码', key: 'tsCode', width: 100, fixed: 'left' },
  { title: '名称', key: 'name', width: 90 },
  {
    title: '涨跌幅%',
    key: 'pctChange',
    width: 90,
    sorter: (a, b) => Number(a.pctChange) - Number(b.pctChange),
    render: (row) => {
      const v = Number(row.pctChange)
      const cls = v > 0 ? 'positive' : v < 0 ? 'negative' : ''
      return h('span', { class: cls }, `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`)
    },
  },
  {
    title: '净流入(万)',
    key: 'netAmount',
    width: 110,
    sorter: (a, b) => Number(a.netAmount) - Number(b.netAmount),
    defaultSortOrder: 'descend',
    render: (row) => {
      const v = Number(row.netAmount)
      return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2))
    },
  },
  {
    title: '大单净额(万)',
    key: 'buyLgAmount',
    width: 115,
    sorter: (a, b) => Number(a.buyLgAmount) - Number(b.buyLgAmount),
    render: (row) => {
      const v = Number(row.buyLgAmount)
      return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2))
    },
  },
  { title: '大单占比%', key: 'buyLgAmountRate', width: 100, render: (row) => `${Number(row.buyLgAmountRate).toFixed(2)}%` },
  {
    title: '中单净额(万)',
    key: 'buyMdAmount',
    width: 115,
    render: (row) => {
      const v = Number(row.buyMdAmount)
      return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2))
    },
  },
  {
    title: '小单净额(万)',
    key: 'buySmAmount',
    width: 115,
    render: (row) => {
      const v = Number(row.buySmAmount)
      return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2))
    },
  },
]

async function load() {
  if (!currentParams.value.trade_date && !currentParams.value.start_date) return
  loading.value = true
  try {
    rows.value = await moneyFlowApi.queryStocks(currentParams.value)
  } catch {
    rows.value = []
  } finally {
    loading.value = false
  }
}

function onDateChange(params: MoneyFlowQueryParams) {
  currentParams.value = params
  load()
}

onActivated(load)
</script>

<style scoped>
.stock-flow-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-controls { display: flex; align-items: center; gap: 16px; flex-wrap: wrap; }
.panel-body { display: grid; grid-template-columns: 1fr 1.5fr; gap: 20px; }
.chart-col, .table-col { min-width: 0; }
.empty-state { color: var(--color-text-muted); text-align: center; padding: 40px; }
.empty-state a { color: var(--color-primary); }
:deep(.positive) { color: #f04747; }
:deep(.negative) { color: #4caf8a; }
</style>
