<template>
  <div class="dashboard-panel">
    <!-- Header -->
    <header class="panel-header">
      <div class="header-left">
        <span class="panel-title">资金流向看板</span>
        <span v-if="tradeDateDisplay" class="trade-date">交易日 {{ tradeDateDisplay }}</span>
      </div>
    </header>

    <!-- Dimension Switcher -->
    <div class="dimension-switcher">
      <n-radio-group v-model:value="dimension" size="small">
        <n-radio-button value="concept">概念</n-radio-button>
        <n-radio-button value="sw1">申万一级</n-radio-button>
        <n-radio-button value="sw2">申万二级</n-radio-button>
        <n-radio-button value="sw3">申万三级</n-radio-button>
        <n-radio-button value="thsIndustry">同花顺行业</n-radio-button>
      </n-radio-group>
    </div>

    <!-- KPI Cards -->
    <div class="kpi-cards">
      <div class="kpi-card">
        <div class="kpi-label">净流入</div>
        <div class="kpi-value inflow">{{ formatAmount(inflowTotal) }}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">净流出</div>
        <div class="kpi-value outflow">{{ formatAmount(-outflowTotal) }}</div>
      </div>
      <div class="kpi-card">
        <div class="kpi-label">净额</div>
        <div class="kpi-value" :class="netTotal >= 0 ? 'inflow' : 'outflow'">
          {{ formatAmount(netTotal) }}
        </div>
      </div>
    </div>

    <!-- Chart Toolbar: 每侧显示数量控制
         topN: number|null，正/负侧各取头部 N 个，null=全部。
         naive-ui NRadioButton 的 value 类型虽未声明 null，但运行时用 === 比较，
         null===null 匹配可靠（vue-tsc 已通过）。 -->
    <div class="chart-toolbar">
      <span class="toolbar-label">每侧</span>
      <n-radio-group v-model:value="topN" size="small">
        <n-radio-button :value="10">10</n-radio-button>
        <n-radio-button :value="20">20</n-radio-button>
        <n-radio-button :value="30">30</n-radio-button>
        <n-radio-button :value="null">全部</n-radio-button>
      </n-radio-group>
      <span class="toolbar-count">共 {{ totalNodesCount }} 个板块</span>
    </div>

    <!-- Bubble Chart -->
    <div class="chart-body">
      <n-spin :show="loading">
        <div v-if="error" class="error-state">{{ error }}</div>
        <BubbleCloudChart
          v-else
          :nodes="displayNodes"
          :loading="loading"
          @bubble-click="onBubbleClick"
        />
      </n-spin>
    </div>

    <!-- Legend -->
    <div class="chart-legend">
      <span class="legend-item">
        <span class="legend-dot inflow" />
        <span class="legend-text">净流入</span>
      </span>
      <span class="legend-item">
        <span class="legend-dot outflow" />
        <span class="legend-text">净流出</span>
      </span>
      <span class="legend-item">
        <span class="legend-text">大小 = 规模</span>
      </span>
    </div>

    <!-- Trend Modal -->
    <FlowTrendModal
      v-model:visible="modalVisible"
      :ts-code="modalTsCode"
      :entity-name="modalName"
      :fetch-fn="modalFetchFn"
      chart-mode="bar"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesDashboardPanel' })

import { onMounted, ref, watch } from 'vue'
import { NRadioButton, NRadioGroup, NSpin } from 'naive-ui'
import { moneyFlowApi, type MoneyFlowQueryParams } from '@/api/modules/market/moneyFlow'
import type { BarChartRow } from '@/components/money-flow/money-flow.types'
import FlowTrendModal from '@/components/money-flow/FlowTrendModal.vue'
import BubbleCloudChart from './BubbleCloudChart.vue'
import { useDashboardData, type DashboardDimension } from './useDashboardData'

const {
  dimension,
  displayNodes,
  topN,
  totalNodesCount,
  loading,
  error,
  tradeDate,
  inflowTotal,
  outflowTotal,
  netTotal,
  reload,
} = useDashboardData()

onMounted(() => {
  void reload()
})

// ----- Trade date display (YYYYMMDD → YYYY-MM-DD) -----
const tradeDateDisplay = ref('')
watch(tradeDate, (val) => {
  tradeDateDisplay.value = val
    ? `${val.slice(0, 4)}-${val.slice(4, 6)}-${val.slice(6, 8)}`
    : ''
}, { immediate: true })

// ----- KPI formatting -----
function formatAmount(v: number): string {
  const fixed = Math.abs(v).toFixed(2)
  return `${v >= 0 ? '+' : ''}${v < 0 ? '-' : ''}${fixed}亿`
}

// ----- FlowTrendModal: bar-mode fetchers -----
function fetchSectorBarTrend(params: MoneyFlowQueryParams): Promise<BarChartRow[]> {
  return moneyFlowApi.querySectors(params).then(rows =>
    rows.map(r => ({
      label: r.tradeDate,
      value: Number(r.netAmount) || 0,
    })),
  )
}

function fetchIndustryBarTrend(params: MoneyFlowQueryParams): Promise<BarChartRow[]> {
  return moneyFlowApi.queryIndustries(params).then(rows =>
    rows.map(r => ({
      label: r.tradeDate,
      value: Number(r.netAmount) || 0,
    })),
  )
}

function fetchThsIndustryBarTrend(params: MoneyFlowQueryParams): Promise<BarChartRow[]> {
  return moneyFlowApi.queryThsIndustries(params).then(rows =>
    rows.map(r => ({
      label: r.tradeDate,
      value: Number(r.netAmount) || 0,
    })),
  )
}

// ----- Modal state -----
const modalVisible = ref(false)
const modalTsCode = ref('')
const modalName = ref('')
const modalFetchFn = ref<(params: MoneyFlowQueryParams) => Promise<BarChartRow[]>>(
  fetchSectorBarTrend,
)

function onBubbleClick(payload: { tsCode: string; name: string; value: number }) {
  modalTsCode.value = payload.tsCode
  modalName.value = payload.name

  switch (dimension.value) {
    case 'concept':
      modalFetchFn.value = fetchSectorBarTrend
      break
    case 'thsIndustry':
      modalFetchFn.value = fetchThsIndustryBarTrend
      break
    case 'sw1':
    case 'sw2':
    case 'sw3':
      modalFetchFn.value = fetchIndustryBarTrend
      break
  }

  modalVisible.value = true
}
</script>

<style scoped>
.dashboard-panel {
  display: flex;
  flex-direction: column;
  gap: 16px;
  height: 100%;
}

.panel-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
}

.header-left {
  display: flex;
  align-items: center;
  gap: 12px;
}

.panel-title {
  font-size: 16px;
  font-weight: 600;
}

.trade-date {
  font-size: 13px;
  color: var(--color-text-muted);
}

.dimension-switcher {
  flex-shrink: 0;
}

/* KPI Cards */
.kpi-cards {
  display: flex;
  gap: 16px;
  flex-shrink: 0;
}

.kpi-card {
  flex: 1;
  background: var(--color-card-bg, rgba(255, 255, 255, 0.04));
  border: 1px solid var(--color-border, rgba(255, 255, 255, 0.08));
  border-radius: 8px;
  padding: 12px 16px;
  text-align: center;
}

.kpi-label {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-bottom: 4px;
}

.kpi-value {
  font-size: 18px;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}

.kpi-value.inflow {
  color: #0ECB81;
}

.kpi-value.outflow {
  color: #F6465D;
}

/* Chart body */
.chart-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}

/* Chart toolbar: 显示数量控制条 */
.chart-toolbar {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 4px 0;
  flex-shrink: 0;
}

.toolbar-label {
  font-size: 12px;
  color: var(--color-text-muted);
}

.toolbar-count {
  font-size: 12px;
  color: var(--color-text-muted);
  margin-left: auto;
}

.error-state {
  color: #F6465D;
  text-align: center;
  padding: 60px 20px;
  font-size: 14px;
}

/* Legend */
.chart-legend {
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 20px;
  padding: 8px 0;
  flex-shrink: 0;
}

.legend-item {
  display: flex;
  align-items: center;
  gap: 6px;
  font-size: 12px;
  color: var(--color-text-muted);
}

.legend-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  display: inline-block;
}

.legend-dot.inflow {
  background: #0ECB81;
}

.legend-dot.outflow {
  background: #F6465D;
}
</style>
