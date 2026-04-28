<template>
  <div class="metrics-wrap">
    <CandleRunSymbolMetricsFilterBar
      v-model:search-query="searchQuery"
      v-model:status-values="statusValues"
      :loading="loading"
      :conditions="conditions"
      :field-options="fieldOptions"
      @apply="applyFilters"
      @reset="resetFilters"
      @add-condition="addCondition"
      @remove-condition="removeCondition"
    />

    <n-card class="data-card" :bordered="false" size="small" title="本根 K · 回测标的池指标">
      <n-data-table
        :columns="columns"
        :data="items"
        :loading="loading"
        :pagination="paginationState"
        :scroll-x="1360"
        remote
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
        @update:sorter="handleSort"
      />
    </n-card>

    <KlineChartModal v-model:show="klineModalShow" :run-id="runId" :ts="ts" :symbol="klineSymbol" />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref, watch } from 'vue'
import { NCard, NDataTable, useMessage, type DataTableSortState } from 'naive-ui'
import {
  DEFAULT_STATUS_VALUES,
  STATUS_BUY,
  STATUS_HOLD,
  STATUS_SELL,
  type RunSymbolMetricCondition,
  type StatusFilterValue,
} from '../../composables/backtest/candleRunSymbolMetrics'
import {
  useCandleRunSymbolMetricsColumns,
  type ColSortOrder,
} from '../../composables/backtest/useCandleRunSymbolMetricsColumns'
import { backtestApi, symbolApi, type RunSymbolMetricRow } from '@/api'
import CandleRunSymbolMetricsFilterBar from './CandleRunSymbolMetricsFilterBar.vue'
import KlineChartModal from './KlineChartModal.vue'

const props = defineProps<{
  show: boolean
  runId: string
  ts: string
}>()

const message = useMessage()

const searchQuery = ref('')
const statusValues = ref<StatusFilterValue[]>([...DEFAULT_STATUS_VALUES])
const conditions = ref<RunSymbolMetricCondition[]>([])
const fieldOptions = ref<Array<{ label: string; value: string }>>([])
const klineModalShow = ref(false)
const klineSymbol = ref<string | null>(null)
const loading = ref(false)
const items = ref<RunSymbolMetricRow[]>([])
const total = ref(0)
const page = ref(1)
const pageSize = ref(10)
const sortKey = ref('symbol')
const sortOrder = ref<'ascend' | 'descend' | null>(null)
const explicitSort = ref(false)

const paginationState = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  prefix: () => `共 ${total.value} 条`,
}))

const headerOrder = (key: string): ColSortOrder =>
  explicitSort.value && sortKey.value === key
    ? sortOrder.value === 'descend'
      ? 'descend'
      : 'ascend'
    : false

const openKline = (symbol: string) => {
  klineSymbol.value = symbol
  klineModalShow.value = true
}

const { columns } = useCandleRunSymbolMetricsColumns({
  headerOrder,
  onOpenKline: openKline,
})

const buildBody = () => ({
  ts: props.ts,
  q: searchQuery.value,
  conditions: conditions.value,
  sort: {
    field: explicitSort.value ? sortKey.value : 'symbol',
    asc: explicitSort.value ? sortOrder.value !== 'descend' : true,
  },
  page: page.value,
  page_size: pageSize.value,
  only_buy_on_bar: statusValues.value.includes(STATUS_BUY),
  only_sell_on_bar: statusValues.value.includes(STATUS_SELL),
  only_open_at_close: statusValues.value.includes(STATUS_HOLD),
})

const loadData = async () => {
  if (!props.show || !props.runId || !props.ts.trim()) return
  loading.value = true
  try {
    const response = await backtestApi.querySymbolMetrics(props.runId, buildBody())
    items.value = response.items
    total.value = response.total
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
    items.value = []
    total.value = 0
  } finally {
    loading.value = false
  }
}

const loadFields = async () => {
  try {
    const columns = await symbolApi.getKlineColumns()
    fieldOptions.value = columns.map((column) => ({ label: column, value: column }))
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

const applyFilters = () => {
  page.value = 1
  void loadData()
}

const resetFilters = () => {
  conditions.value = []
  searchQuery.value = ''
  statusValues.value = []
  page.value = 1
  explicitSort.value = false
  sortKey.value = 'symbol'
  sortOrder.value = null
  void loadData()
}

const addCondition = (condition: RunSymbolMetricCondition) => {
  conditions.value.push(condition)
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
  const order = state?.order

  if (order === false || order === undefined) {
    explicitSort.value = false
    sortKey.value = 'symbol'
    sortOrder.value = null
  } else {
    explicitSort.value = true
    sortKey.value = typeof state?.columnKey === 'string' ? state.columnKey : 'symbol'
    sortOrder.value = order
  }

  page.value = 1
  void loadData()
}

watch(
  () => [props.show, props.runId, props.ts] as const,
  ([visible]) => {
    if (!visible || !props.runId || !props.ts.trim()) {
      items.value = []
      total.value = 0
      klineModalShow.value = false
      klineSymbol.value = null
      return
    }

    page.value = 1
    void loadData()
  },
)

onMounted(() => {
  void loadFields()
  if (props.show && props.runId && props.ts.trim()) {
    void loadData()
  }
})
</script>

<style scoped src="./candle-run-symbol-metrics.css"></style>
