<!-- apps/web/src/components/money-flow/SectorFlowPanel.vue -->
<template>
  <div class="industry-flow-panel">
    <div class="panel-controls">
      <FlowDateControl @change="onDateChange" />
    </div>

    <FlowKpiCards :cards="kpiCards" :loading="loading" />

    <div class="panel-body">
      <div class="chart-col">
        <FlowBarChart :rows="chartRows" :max-rows="30" />
      </div>
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
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SectorFlowPanel' })

import { computed, h, onActivated, ref } from 'vue'
import { NDataTable } from 'naive-ui'
import type { DataTableColumns } from 'naive-ui'
import { moneyFlowApi, type MoneyFlowQueryParams, type MoneyFlowSectorRow } from '@/api/modules/moneyFlow'
import FlowDateControl from './FlowDateControl.vue'
import FlowKpiCards from './FlowKpiCards.vue'
import FlowBarChart from './FlowBarChart.vue'
import type { KpiCardItem, BarChartRow } from './money-flow.types'

const rows = ref<MoneyFlowSectorRow[]>([])
const loading = ref(false)
const currentParams = ref<MoneyFlowQueryParams>({})

const kpiCards = computed((): KpiCardItem[] => {
  const sorted = [...rows.value].sort((a, b) => Number(b.netAmount) - Number(a.netAmount))
  const top1In = sorted[0]
  const top1Out = sorted[sorted.length - 1]
  const inCount = rows.value.filter(r => Number(r.netAmount) > 0).length
  return [
    { label: '净流入最多', value: top1In?.netAmount ?? null, sub: top1In?.sector ?? '' },
    { label: '净流出最多', value: top1Out?.netAmount ?? null, sub: top1Out?.sector ?? '' },
    { label: '净流入板块数', value: String(inCount), sub: `共${rows.value.length}个板块` },
    { label: '合计净流入', value: rows.value.reduce((s, r) => s + (Number(r.netAmount) || 0), 0).toFixed(0), sub: '万元' },
  ]
})

const chartRows = computed((): BarChartRow[] =>
  rows.value.map(r => ({ label: r.sector, value: Number(r.netAmount) || 0 })),
)

const columns: DataTableColumns<MoneyFlowSectorRow> = [
  { title: '板块', key: 'sector', width: 120 },
  { title: '涨跌幅%', key: 'pctChange', width: 90, sorter: (a, b) => Number(a.pctChange) - Number(b.pctChange), render: row => { const v = Number(row.pctChange); return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, `${v >= 0 ? '+' : ''}${v.toFixed(2)}%`) } },
  { title: '净流入(万)', key: 'netAmount', width: 110, defaultSortOrder: 'descend' as const, sorter: (a, b) => Number(a.netAmount) - Number(b.netAmount), render: row => { const v = Number(row.netAmount); return h('span', { class: v > 0 ? 'positive' : v < 0 ? 'negative' : '' }, v.toFixed(2)) } },
  { title: '净买入(万)', key: 'netBuyAmount', width: 110, sorter: (a, b) => Number(a.netBuyAmount) - Number(b.netBuyAmount), render: row => { const v = Number(row.netBuyAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
  { title: '净卖出(万)', key: 'netSellAmount', width: 110, render: row => { const v = Number(row.netSellAmount); return h('span', { class: v > 0 ? 'positive' : 'negative' }, v.toFixed(2)) } },
]

async function load() {
  if (!currentParams.value.trade_date && !currentParams.value.start_date) return
  loading.value = true
  try {
    rows.value = await moneyFlowApi.querySectors(currentParams.value)
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
.industry-flow-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-controls { display: flex; align-items: center; gap: 16px; }
.panel-body { display: grid; grid-template-columns: 1fr 1.5fr; gap: 20px; }
.chart-col, .table-col { min-width: 0; }
.empty-state { color: var(--color-text-muted); text-align: center; padding: 40px; }
.empty-state a { color: var(--color-primary); }
:deep(.positive) { color: #f04747; }
:deep(.negative) { color: #4caf8a; }
</style>
