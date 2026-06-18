<template>
  <div class="crypto-symbols-panel">
    <div class="page-header workspace-page-header">
      <h2 class="panel-title">加密货币</h2>
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
        <n-button secondary @click="showColumnSettings = true">
          <template #icon><n-icon><settings-outline /></n-icon></template>
          Columns
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
        <n-select
          v-model:value="selectedWatchlistIds"
          :options="watchlistOptions"
          multiple
          filterable
          placeholder="标签"
          clearable
          style="width: 200px"
          @update:value="applyFilters"
        />
        <n-select
          v-model:value="selectedStrategyIds"
          :options="strategyFilterOptions"
          multiple
          filterable
          placeholder="策略命中"
          clearable
          style="width: 200px"
          @update:value="applyFilters"
        />
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
          {{ formatConditionTag(cond) }}
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
        <kline-chart
          v-if="klineData.length"
          :data="displayKlineData"
          height="700px"
          :slider-start="70"
          show-toolbar
          :granularity="cryptoGranularity"
          :range="klineRange"
          prefs-key="crypto"
          :available-subplots="cryptoAvailableSubplots"
          @update:range="onKlineRangeChange"
        />
        <n-empty v-else description="No kline data" style="padding: 40px 0" />
      </n-drawer-content>
    </n-drawer>

    <column-settings-drawer
      v-model:show="showColumnSettings"
      v-model:modelValue="scopePreferences"
      title="Crypto Columns"
      :definitions="columnDefs"
      :loading="columnPrefsLoading"
      :saving="columnPrefsSaving"
      @save="handleSaveColumnPreferences"
    />
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
  NEmpty,
  NIcon,
  NInput,
  NSelect,
  NSpace,
  NTag,
  type DataTableSortState,
  useMessage,
} from 'naive-ui'
import { RefreshOutline, SearchOutline, SettingsOutline } from '@vicons/ionicons5'
import KlineChart from '../kline/KlineChart.vue'
import NumericConditionFilter from '../common/NumericConditionFilter.vue'
import type { NumericCondition, NumericConditionFieldOption } from '../common/numericConditionFilterTypes'
import type { SubplotKey } from '@/composables/kline/subplotConfig'
import { useKlineRangePicker } from '@/composables/kline/useKlineRangePicker'
import { sliceTimestampBarsByRange } from '@/composables/kline/klineDateRange'
import { klinesApi, symbolApi, type KlineChartBar, type SymbolRow } from '@/api'
import ColumnSettingsDrawer from './ColumnSettingsDrawer.vue'
import { createCryptoColumnDefs } from './cryptoColumns'
import { useSymbolColumnPreferences } from '@/composables/symbols/useSymbolColumnPreferences'
import { useWatchlistTagFilter } from '@/composables/symbols/useWatchlistTagFilter'
import { useStrategyConditionsStore } from '@/stores/strategyConditions'
import { strategyConditionsApi } from '@/api/modules/strategy/strategyConditions'

const message = useMessage()

const selectedInterval = ref('1h')
const intervalOptions = [
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
]

// 加密 K 线工具栏：粒度由当前 interval 派生；副图不含 FLOW（无资金流数据源）
const cryptoGranularity = computed<'date' | 'hour' | 'minute'>(() =>
  selectedInterval.value === '1d' ? 'date' : 'hour',
)
const cryptoAvailableSubplots: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']

const loading = ref(false)
const symbols = ref<SymbolRow[]>([])
const total = ref(0)
const searchQuery = ref('')
const showChartDrawer = ref(false)
const showColumnSettings = ref(false)
const selectedSymbol = ref('')
const klineData = ref<KlineChartBar[]>([])

// 工具栏日期选择器：A 类客户端裁切。后端 /klines/:symbol/:interval 返回全量历史（已握全量），
// 无需服务端重查；选区由 displayKlineData 响应裁切（date 粒度比本地日历日 / hour 粒度比 instant）。
const { range: klineRange, onRangeUpdate: onKlineRangeChange, reset: resetKlineRange } =
  useKlineRangePicker()

const displayKlineData = computed<KlineChartBar[]>(() =>
  sliceTimestampBarsByRange(klineData.value, klineRange.value, cryptoGranularity.value),
)
const conditions = ref<NumericCondition[]>([])
const fieldOptions = ref<NumericConditionFieldOption[]>([])
const sortKey = ref<string | null>(null)
const sortOrder = ref<'ascend' | 'descend' | null>(null)
const page = ref(1)
const pageSize = ref(20)
const selectedStrategyIds = ref<string[]>([])
const hitLookup = ref<Map<string, Set<string>>>(new Map())

const strategyStore = useStrategyConditionsStore()

const strategyFilterOptions = computed(() => {
  return strategyStore.conditions
    .filter(c => c.targetType === 'crypto')
    .filter(c => {
      const status = strategyStore.runStatuses.get(c.id)
      return status && (status.freshness === 'fresh' || status.freshness === 'stale')
    })
    .map(c => ({
      label: `${c.name} (${strategyStore.runStatuses.get(c.id)?.totalHits ?? 0} 命中)`,
      value: c.id,
    }))
})

async function loadHitLookup() {
  const newLookup = new Map<string, Set<string>>()
  for (const condition of strategyStore.conditions) {
    if (condition.targetType !== 'crypto') continue
    const status = strategyStore.runStatuses.get(condition.id)
    if (!status || (status.freshness !== 'fresh' && status.freshness !== 'stale')) continue
    try {
      const result = await strategyConditionsApi.getRunResult(condition.id)
      for (const hit of result.hits) {
        const names = newLookup.get(hit.tsCode) ?? new Set<string>()
        names.add(condition.name)
        newLookup.set(hit.tsCode, names)
      }
    } catch { /* ignore */ }
  }
  hitLookup.value = newLookup
}

const baseColumnDefs = createCryptoColumnDefs({ onViewChart: openChart })
const columnDefs = [
  ...baseColumnDefs,
  {
    title: '买入信号',
    key: 'buySignal',
    width: 200,
    defaultVisible: true,
    render: (row: SymbolRow) => {
      const matchedNames = hitLookup.value.get(row.symbol)
      if (!matchedNames || matchedNames.size === 0) return '-'
      return h(NSpace, { size: 4 }, {
        default: () => [...matchedNames].map(name =>
          h(NTag, { type: 'success', size: 'small' }, { default: () => name })),
      })
    },
  },
]
const {
  loading: columnPrefsLoading,
  saving: columnPrefsSaving,
  scopePreferences,
  columns,
  load: loadColumnPreferences,
  save: saveColumnPreferences,
} = useSymbolColumnPreferences('crypto', columnDefs)

const {
  selectedWatchlistIds,
  watchlistOptions,
  watchlistIds,
  resetWatchlistFilter,
  ensureWatchlistsLoaded,
} = useWatchlistTagFilter()

const opLabels: Record<NumericCondition['op'], string> = {
  gt: '>',
  gte: '>=',
  lt: '<',
  lte: '<=',
  eq: '=',
  neq: '!=',
}

const formatConditionTag = (condition: NumericCondition) => {
  const rightValue = condition.valueType === 'field' ? condition.compareField : condition.value
  return `${condition.field} ${opLabels[condition.op]} ${rightValue}`
}

const paginationState = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  prefix: () => `Total ${total.value}`,
}))

const buildQuery = () => ({
  interval: selectedInterval.value,
  q: searchQuery.value,
  conditions: conditions.value,
  watchlistIds: watchlistIds.value,
  strategyHitIds: selectedStrategyIds.value,
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
  selectedStrategyIds.value = []
  resetWatchlistFilter()
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

async function openChart(symbol: string) {
  selectedSymbol.value = symbol
  showChartDrawer.value = true
  resetKlineRange() // 新标的：清空选区，回默认窗口（全量历史）
  klineData.value = []
  try {
    klineData.value = await klinesApi.getKlines(symbol, selectedInterval.value)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

async function handleSaveColumnPreferences() {
  try {
    await saveColumnPreferences()
    showColumnSettings.value = false
    message.success('列设置已保存')
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

onMounted(async () => {
  void ensureWatchlistsLoaded()
  void loadFields()
  void loadColumnPreferences().catch((err: unknown) => {
    message.error(err instanceof Error ? err.message : String(err))
  })
  void loadData()
  await strategyStore.fetchConditions('crypto')
  await strategyStore.fetchLastRunStatus()
  await loadHitLookup()
})
</script>

<style scoped>
.crypto-symbols-panel { display: flex; flex-direction: column; gap: 18px; }
.panel-title { margin: 0; font-size: 22px; line-height: 1.2; }
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.filter-tags { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
</style>
