<template>
  <div class="symbols-view workspace-page">
    <div class="page-header workspace-page-header">
      <h1 class="page-title workspace-page-title">Symbols</h1>
      <n-space>
        <n-select
          v-model:value="selectedInterval"
          :options="intervalOptions"
          style="width: 120px"
          @update:value="loadData"
        />
        <n-button :loading="loading" @click="loadData">
          <template #icon><n-icon><refresh-outline /></n-icon></template>
          Refresh
        </n-button>
      </n-space>
    </div>

    <n-card class="filter-card" :bordered="false">
      <div class="filter-row">
        <n-input
          v-model:value="searchQuery"
          placeholder="Search symbol..."
          clearable
          style="width: 200px"
          @keyup.enter="applyFilters"
        >
          <template #prefix><n-icon><search-outline /></n-icon></template>
        </n-input>
        <n-button @click="showFilterDrawer = true">
          <template #icon><n-icon><filter-outline /></n-icon></template>
          Filters
          <n-badge v-if="conditions.length" :value="conditions.length" />
        </n-button>
        <n-button @click="resetFilters">Reset</n-button>
        <n-button type="primary" @click="applyFilters">Apply</n-button>
      </div>
      <div v-if="conditions.length" class="filter-tags">
        <n-tag v-for="(cond, index) in conditions" :key="index" closable @close="removeCondition(index)">
          {{ cond.field }} {{ opLabels[cond.op] }} {{ cond.value }}
        </n-tag>
      </div>
    </n-card>

    <n-card class="data-card" :bordered="false">
      <n-data-table
        :columns="columns"
        :data="symbols"
        :loading="loading"
        :pagination="paginationState"
        remote
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
        @update:sorter="handleSort"
      />
    </n-card>

    <n-drawer v-model:show="showFilterDrawer" placement="right" :width="400" class="glass-drawer">
      <n-drawer-content title="Filters" closable>
        <div class="filter-form">
          <h4>Field</h4>
          <n-select v-model:value="newCondition.field" :options="fieldOptions" placeholder="Select field" />
          <h4>Operator</h4>
          <n-select v-model:value="newCondition.op" :options="opOptions" placeholder="Select operator" />
          <h4>Value</h4>
          <n-input-number v-model:value="newCondition.value" style="width: 100%" />
          <n-button
            type="primary"
            block
            style="margin-top: 12px"
            :disabled="!canAddCondition"
            @click="addCondition"
          >
            Add condition
          </n-button>
          <n-divider />
          <h4>Current conditions</h4>
          <n-empty v-if="!conditions.length" description="No conditions" />
          <div v-else class="condition-list">
            <div v-for="(cond, index) in conditions" :key="index" class="condition-item">
              <span>{{ cond.field }} {{ opLabels[cond.op] }} {{ cond.value }}</span>
              <n-button quaternary circle size="small" @click="removeCondition(index)">
                <template #icon><n-icon><close-outline /></n-icon></template>
              </n-button>
            </div>
          </div>
        </div>
      </n-drawer-content>
    </n-drawer>

    <n-drawer
      v-model:show="showChartDrawer"
      placement="right"
      :width="1000"
      class="glass-drawer"
      @after-enter="renderChart"
    >
      <n-drawer-content :title="`${selectedSymbol} · ${selectedInterval.toUpperCase()}`" closable>
        <div ref="chartRef" class="kline-chart" />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'SymbolsView' })

import { computed, h, onMounted, onUnmounted, ref } from 'vue'
import * as echarts from 'echarts'
import {
  NBadge,
  NButton,
  NCard,
  NDataTable,
  NDivider,
  NDrawer,
  NDrawerContent,
  NEmpty,
  NIcon,
  NInput,
  NInputNumber,
  NSelect,
  NSpace,
  NTag,
  NTooltip,
  type DataTableColumns,
  type DataTableSortState,
  useMessage,
} from 'naive-ui'
import { CloseOutline, FilterOutline, RefreshOutline, SearchOutline, TrendingUpOutline } from '@vicons/ionicons5'
import { buildKlineChartGraphics, buildKlineChartOption } from '../composables/kline/klineChartOptions'
import { klinesApi, symbolApi, type KlineChartBar } from '../composables/useApi'
import { useTheme } from '../composables/useTheme'

interface FilterCondition {
  field: string
  op: 'gt' | 'lt' | 'gte' | 'lte'
  value: number
}

interface FieldOption {
  label: string
  value: string
}

interface SymbolRow {
  symbol: string
  close?: number | null
  ma5?: number | null
  ma30?: number | null
  ma60?: number | null
  kdjJ?: number | null
  riskRewardRatio?: number | null
  stopLossPct?: number | null
  openTime?: string | null
}

const message = useMessage()
const { echartsTheme } = useTheme()

const selectedInterval = ref('1h')
const intervalOptions = [
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
]

const loading = ref(false)
const symbols = ref<SymbolRow[]>([])
const total = ref(0)
const searchQuery = ref('')
const showFilterDrawer = ref(false)
const showChartDrawer = ref(false)
const selectedSymbol = ref('')
const chartRef = ref<HTMLElement | null>(null)
const conditions = ref<FilterCondition[]>([])
const newCondition = ref<FilterCondition>({ field: '', op: 'gt', value: 0 })
const fieldOptions = ref<FieldOption[]>([])
const sortKey = ref<string | null>(null)
const sortOrder = ref<'ascend' | 'descend' | null>(null)
const page = ref(1)
const pageSize = ref(20)

let chart: echarts.ECharts | null = null
let klineData: KlineChartBar[] = []

const opOptions = [
  { label: '>', value: 'gt' },
  { label: '<', value: 'lt' },
  { label: '>=', value: 'gte' },
  { label: '<=', value: 'lte' },
] satisfies Array<{ label: string; value: FilterCondition['op'] }>

const opLabels: Record<FilterCondition['op'], string> = {
  gt: '>',
  lt: '<',
  gte: '>=',
  lte: '<=',
}

const canAddCondition = computed(() => Boolean(newCondition.value.field))

const paginationState = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  prefix: () => `Total ${total.value}`,
}))

const formatFixed = (value: number | null | undefined, digits: number) =>
  value == null ? '-' : value.toFixed(digits)

const columns = computed<DataTableColumns<SymbolRow>>(() => [
  { title: 'Symbol', key: 'symbol', width: 120, fixed: 'left', sorter: true },
  {
    title: 'Close',
    key: 'close',
    width: 110,
    sorter: true,
    render: (row) => (row.close == null ? '-' : Number(row.close).toPrecision(6)),
  },
  { title: 'MA5', key: 'ma5', width: 110, sorter: true, render: (row) => formatFixed(row.ma5, 4) },
  { title: 'MA30', key: 'ma30', width: 110, sorter: true, render: (row) => formatFixed(row.ma30, 4) },
  { title: 'MA60', key: 'ma60', width: 110, sorter: true, render: (row) => formatFixed(row.ma60, 4) },
  { title: 'KDJ.J', key: 'kdjJ', width: 90, sorter: true, render: (row) => formatFixed(row.kdjJ, 2) },
  {
    title: 'RR',
    key: 'riskRewardRatio',
    width: 90,
    sorter: true,
    render: (row) => formatFixed(row.riskRewardRatio, 2),
  },
  {
    title: 'Stop %',
    key: 'stopLossPct',
    width: 90,
    sorter: true,
    render: (row) => (row.stopLossPct == null ? '-' : `${row.stopLossPct.toFixed(2)}%`),
  },
  {
    title: 'Updated',
    key: 'openTime',
    width: 110,
    sorter: true,
    render: (row) => (row.openTime ? new Date(row.openTime).toISOString().slice(0, 10) : '-'),
  },
  {
    title: 'Action',
    key: 'actions',
    width: 70,
    fixed: 'right',
    render: (row) =>
      h(NTooltip, null, {
        trigger: () =>
          h(
            NButton,
            { size: 'small', onClick: () => void openChart(row.symbol) },
            { icon: () => h(NIcon, null, () => h(TrendingUpOutline)) },
          ),
        default: () => 'Open chart',
      }),
  },
])

const buildQuery = () => ({
  interval: selectedInterval.value,
  q: searchQuery.value,
  conditions: conditions.value,
  sort: { field: sortKey.value ?? 'symbol', asc: sortOrder.value !== 'descend' },
  page: page.value,
  page_size: pageSize.value,
})

const handleResize = () => chart?.resize()

const loadData = async () => {
  loading.value = true
  try {
    const res = await symbolApi.query(buildQuery())
    symbols.value = res.items as SymbolRow[]
    total.value = res.total
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }
}

const loadFields = async () => {
  try {
    const cols = await symbolApi.getKlineColumns()
    fieldOptions.value = cols.map((col) => ({ label: col, value: col }))
  } catch {
    fieldOptions.value = []
  }
}

const applyFilters = () => {
  page.value = 1
  void loadData()
}

const resetFilters = () => {
  conditions.value = []
  searchQuery.value = ''
  page.value = 1
  void loadData()
}

const addCondition = () => {
  if (!canAddCondition.value) return
  conditions.value.push({ ...newCondition.value })
  newCondition.value = { field: '', op: 'gt', value: 0 }
}

const removeCondition = (index: number) => {
  conditions.value.splice(index, 1)
  applyFilters()
}

const handlePageChange = (nextPage: number) => {
  page.value = nextPage
  void loadData()
}

const handlePageSizeChange = (nextPageSize: number) => {
  pageSize.value = nextPageSize
  page.value = 1
  void loadData()
}

const handleSort = (sorter: DataTableSortState | DataTableSortState[] | null) => {
  const state = Array.isArray(sorter) ? sorter[0] : sorter
  sortKey.value = typeof state?.columnKey === 'string' ? state.columnKey : null
  sortOrder.value = state?.order || null
  void loadData()
}

const renderChart = () => {
  if (!chartRef.value || !klineData.length) return
  chart?.dispose()
  chart = echarts.init(chartRef.value)
  chart.setOption(
    buildKlineChartOption({
      data: klineData,
      echartsTheme: echartsTheme.value,
      sliderStart: 70,
    }),
  )

  const lastIdx = klineData.length - 1
  chart.on('updateAxisPointer', (ev: unknown) => {
    const event = ev as { axesInfo?: { axisDim: string; value: number }[] }
    const info = event.axesInfo?.find((item) => item.axisDim === 'x')
    const idx = typeof info?.value === 'number' ? info.value : lastIdx
    const safeIdx = idx >= 0 && idx < klineData.length ? idx : lastIdx
    chart?.setOption({ graphic: buildKlineChartGraphics(safeIdx, klineData) })
  })
}

const openChart = async (symbol: string) => {
  selectedSymbol.value = symbol
  showChartDrawer.value = true
  try {
    klineData = await klinesApi.getKlines(symbol, selectedInterval.value)
    renderChart()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(() => {
  void loadFields()
  void loadData()
  window.addEventListener('resize', handleResize)
})

onUnmounted(() => {
  chart?.dispose()
  window.removeEventListener('resize', handleResize)
})
</script>

<style scoped>
.symbols-view { max-width: 1400px; }
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.filter-tags { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
.filter-form h4 { margin: 16px 0 8px; font-size: 14px; font-weight: 600; color: var(--ember-text-secondary); }
.condition-list { display: flex; flex-direction: column; gap: 8px; }
.condition-item { display: flex; justify-content: space-between; align-items: center; padding: 8px 12px; background: var(--ember-surface-hover); border-radius: 8px; }
.kline-chart { height: 700px; width: 100%; }
</style>
