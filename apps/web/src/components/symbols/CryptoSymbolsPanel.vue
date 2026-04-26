<template>
  <div class="crypto-symbols-panel">
    <div class="page-header workspace-page-header">
      <h2 class="panel-title">加密标的</h2>
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
        <numeric-condition-filter
          v-model:conditions="conditions"
          title="Filters"
          button-label="Filters"
          description="Use latest kline indicators to filter symbols."
          :field-options="fieldOptions"
          empty-description="No conditions"
        />
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

    <n-drawer
      v-model:show="showChartDrawer"
      placement="right"
      :width="1000"
      class="glass-drawer"
    >
      <n-drawer-content :title="`${selectedSymbol} · ${selectedInterval.toUpperCase()}`" closable>
        <kline-chart v-if="klineData.length" :data="klineData" height="700px" :slider-start="70" />
        <n-empty v-else description="No kline data" style="padding: 40px 0" />
      </n-drawer-content>
    </n-drawer>
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'CryptoSymbolsPanel' })

import { computed, h, onMounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NDrawer,
  NDrawerContent,
  NIcon,
  NInput,
  NSelect,
  NSpace,
  NTag,
  NTooltip,
  type DataTableColumns,
  type DataTableSortState,
  useMessage,
} from 'naive-ui'
import { RefreshOutline, SearchOutline, TrendingUpOutline } from '@vicons/ionicons5'
import KlineChart from '../kline/KlineChart.vue'
import NumericConditionFilter from '../common/NumericConditionFilter.vue'
import type { NumericCondition, NumericConditionFieldOption } from '../common/numericConditionFilterTypes'
import { klinesApi, symbolApi, type KlineChartBar } from '../../composables/useApi'

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
const showChartDrawer = ref(false)
const selectedSymbol = ref('')
const klineData = ref<KlineChartBar[]>([])
const conditions = ref<NumericCondition[]>([])
const fieldOptions = ref<NumericConditionFieldOption[]>([])
const sortKey = ref<string | null>(null)
const sortOrder = ref<'ascend' | 'descend' | null>(null)
const page = ref(1)
const pageSize = ref(20)

const opLabels: Record<NumericCondition['op'], string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
}

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

const openChart = async (symbol: string) => {
  selectedSymbol.value = symbol
  showChartDrawer.value = true
  klineData.value = []
  try {
    klineData.value = await klinesApi.getKlines(symbol, selectedInterval.value)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(() => {
  void loadFields()
  void loadData()
})
</script>

<style scoped>
.crypto-symbols-panel { display: flex; flex-direction: column; gap: 18px; }
.panel-title { margin: 0; font-size: 22px; line-height: 1.2; }
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.filter-tags { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
</style>
