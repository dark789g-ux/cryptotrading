<template>
  <div class="crypto-symbols-panel">
    <div class="page-header workspace-page-header">
      <h2 class="panel-title">加密货币</h2>
      <n-space>
        <n-select
          v-model:value="selectedInterval"
          :options="intervalOptions"
          style="width: 120px"
          @update:value="reload"
        />
        <n-button :loading="loading" @click="reload">
          <template #icon><n-icon><refresh-outline /></n-icon></template>
          Refresh
        </n-button>
        <n-button secondary @click="showColumnSettings = true">
          <template #icon><n-icon><settings-outline /></n-icon></template>
          Columns
        </n-button>
      </n-space>
    </div>

    <crypto-symbols-filters
      v-model:search-query="searchQuery"
      v-model:selected-watchlist-ids="selectedWatchlistIds"
      v-model:selected-strategy-ids="selectedStrategyIds"
      v-model:conditions="conditions"
      :watchlist-options="watchlistOptions"
      :strategy-options="strategyFilterOptions"
      :field-options="fieldOptions"
      @apply="applyFilters"
      @reset="resetFilters"
    />

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

    <crypto-symbol-detail-drawer
      v-model:show="showChartDrawer"
      :row="selectedRow"
      :interval="selectedInterval"
    />

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
  NIcon,
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from 'naive-ui'
import { RefreshOutline, SettingsOutline } from '@vicons/ionicons5'
import CryptoSymbolsFilters from './crypto/CryptoSymbolsFilters.vue'
import type { NumericCondition, NumericConditionFieldOption } from '../common/numericConditionFilterTypes'
import { symbolApi, type SymbolRow } from '@/api'
import ColumnSettingsDrawer from './ColumnSettingsDrawer.vue'
import CryptoSymbolDetailDrawer from './crypto/CryptoSymbolDetailDrawer.vue'
import { createCryptoColumnDefs } from './cryptoColumns'
import { useSymbolColumnPreferences } from '@/composables/symbols/useSymbolColumnPreferences'
import { useWatchlistTagFilter } from '@/composables/symbols/useWatchlistTagFilter'
import { useStrategyConditionsStore } from '@/stores/strategyConditions'
import { strategyConditionsApi } from '@/api/modules/strategy/strategyConditions'
import { useCryptoSymbolsQuery } from './crypto/useCryptoSymbolsQuery'

const message = useMessage()

const selectedInterval = ref<'1h' | '4h' | '1d'>('1h')
const intervalOptions = [
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
]

const searchQuery = ref('')
const showChartDrawer = ref(false)
const showColumnSettings = ref(false)
const selectedRow = ref<SymbolRow | null>(null)
const conditions = ref<NumericCondition[]>([])
const fieldOptions = ref<NumericConditionFieldOption[]>([])
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

const {
  symbols,
  loading,
  pagination,
  handlePageChange,
  handlePageSizeChange,
  handleSorterChange: handleSort,
  reload,
  applyFilters: applyCryptoFilters,
} = useCryptoSymbolsQuery({
  message,
  interval: selectedInterval,
  searchQuery,
  watchlistIds,
  selectedStrategyIds,
  conditions,
})

const paginationState = computed(() => ({
  page: pagination.value.page,
  pageSize: pagination.value.pageSize,
  itemCount: pagination.value.itemCount,
  showSizePicker: true,
  pageSizes: [10, 20, 50],
  prefix: () => `Total ${pagination.value.itemCount}`,
}))

const loadFields = async () => {
  try {
    const cols = await symbolApi.getKlineColumns()
    fieldOptions.value = cols.map((col) => ({ label: col, value: col }))
  } catch {
    fieldOptions.value = []
  }
}

const applyFilters = () => {
  void applyCryptoFilters()
}

const resetFilters = () => {
  conditions.value = []
  searchQuery.value = ''
  selectedStrategyIds.value = []
  resetWatchlistFilter()
  void applyCryptoFilters()
}

function openChart(row: SymbolRow) {
  selectedRow.value = row
  showChartDrawer.value = true
}

defineExpose({ openChart })

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
  void reload()
  await strategyStore.fetchConditions('crypto')
  await strategyStore.fetchLastRunStatus()
  await loadHitLookup()
})
</script>

<style scoped>
.crypto-symbols-panel { display: flex; flex-direction: column; gap: 18px; }
.panel-title { margin: 0; font-size: 22px; line-height: 1.2; }
</style>
