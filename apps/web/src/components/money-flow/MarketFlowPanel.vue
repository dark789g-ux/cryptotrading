<!-- apps/web/src/components/money-flow/MarketFlowPanel.vue -->
<template>
  <div class="market-flow-panel">
    <div class="panel-controls">
      <FlowDateControl @change="onDateChange" />
    </div>

    <FlowKpiCards :cards="kpiCards" :loading="loading" />

    <div class="chart-area">
      <FlowBarChart :rows="chartRows" />
    </div>

    <div v-if="!loading && !rows.length" class="empty-state">
      暂无数据，请前往
      <router-link to="/sync">数据同步</router-link>
      页面更新资金流向数据。
    </div>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'MarketFlowPanel' })

import { computed, onActivated, ref } from 'vue'
import { moneyFlowApi, type MoneyFlowQueryParams, type MoneyFlowMarketRow } from '@/api/modules/moneyFlow'
import FlowDateControl from './FlowDateControl.vue'
import FlowKpiCards from './FlowKpiCards.vue'
import FlowBarChart from './FlowBarChart.vue'
import type { KpiCardItem, BarChartRow } from './money-flow.types'

const rows = ref<MoneyFlowMarketRow[]>([])
const loading = ref(false)
const currentParams = ref<MoneyFlowQueryParams>({})

const latestRow = computed(() => rows.value[rows.value.length - 1] ?? null)

const kpiCards = computed((): KpiCardItem[] => [
  { label: '大盘净流入', value: latestRow.value?.netAmount ?? null, sub: latestRow.value?.tradeDate ?? '' },
  { label: '主力净流入', value: latestRow.value?.buyLgAmount ?? null, sub: '大单' },
  { label: '散户净流入', value: latestRow.value?.buySmAmount ?? null, sub: '小单' },
  { label: '沪深港通', value: latestRow.value?.hkNetAmount ?? null, sub: '北向资金' },
])

const chartRows = computed((): BarChartRow[] =>
  rows.value.map(r => ({ label: r.tradeDate, value: Number(r.netAmount) || 0 })),
)

async function load() {
  if (!currentParams.value.trade_date && !currentParams.value.start_date) return
  loading.value = true
  try {
    rows.value = await moneyFlowApi.queryMarket(currentParams.value)
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
.market-flow-panel { display: flex; flex-direction: column; gap: 16px; }
.panel-controls { display: flex; align-items: center; gap: 16px; }
.chart-area { min-height: 200px; }
.empty-state { color: var(--color-text-muted); text-align: center; padding: 40px; }
.empty-state a { color: var(--color-primary); }
</style>
