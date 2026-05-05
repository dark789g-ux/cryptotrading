<template>
  <div class="crypto-symbols-panel">
    <div class="page-header workspace-page-header">
      <h2 class="panel-title">鍔犲瘑鏍囩殑</h2>
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
      <n-drawer-content :title="`${selectedSymbol} 路 ${selectedInterval.toUpperCase()}`" closable>
        <kline-chart v-if="klineData.length" :data="klineData" height="700px" :slider-start="70" />
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

import { computed, onMounted, ref } from 'vue'
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
import { klinesApi, symbolApi, type KlineChartBar, type SymbolRow } from '@/api'
import ColumnSettingsDrawer from './ColumnSettingsDrawer.vue'
import { createCryptoColumnDefs } from './cryptoColumns'
import { useSymbolColumnPreferences } from '@/composables/symbols/useSymbolColumnPreferences'
import { useWatchlistTagFilter } from '@/composables/symbols/useWatchlistTagFilter'

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
const showColumnSettings = ref(false)
const selectedSymbol = ref('')
const klineData = ref<KlineChartBar[]>([])
const conditions = ref<NumericCondition[]>([])
const fieldOptions = ref<NumericConditionFieldOption[]>([])
const sortKey = ref<string | null>(null)
const sortOrder = ref<'ascend' | 'descend' | null>(null)
const page = ref(1)
const pageSize = ref(20)

const columnDefs = createCryptoColumnDefs({ onViewChart: openChart })
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

onMounted(() => {
  void ensureWatchlistsLoaded()
  void loadFields()
  void loadColumnPreferences().catch((err: unknown) => {
    message.error(err instanceof Error ? err.message : String(err))
  })
  void loadData()
})
</script>

<style scoped>
.crypto-symbols-panel { display: flex; flex-direction: column; gap: 18px; }
.panel-title { margin: 0; font-size: 22px; line-height: 1.2; }
.filter-row { display: flex; gap: 12px; align-items: center; flex-wrap: wrap; }
.filter-tags { margin-top: 12px; display: flex; gap: 8px; flex-wrap: wrap; }
</style>
