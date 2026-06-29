<template>
  <symbols-panel-layout
    class="crypto-symbols-panel"
    scope="crypto"
    v-model:view-mode="viewMode"
    :loading="loading"
    :show-empty-detail="!selectedDetailRow"
    @refresh="reload"
  >
    <template #header-actions>
      <n-select
        v-model:value="selectedInterval"
        data-testid="interval-select"
        :options="intervalOptions"
        style="width: 120px"
        @update:value="reload"
      />
    </template>

    <template #filters>
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
        @update:show-column-settings="(val: boolean) => showColumnSettings = val"
      />
    </template>

    <template #table>
      <n-card :bordered="false">
        <n-data-table
          data-testid="full-table"
          :columns="tableColumns"
          :data="symbols"
          :loading="loading"
          :pagination="paginationState"
          remote
          @update:page="handlePageChange"
          @update:page-size="handlePageSizeChange"
          @update:sorter="handleSort"
        />
      </n-card>
    </template>

    <template #split-left>
      <n-card :bordered="false" class="split-left-card">
        <n-data-table
          data-testid="split-table"
          :columns="splitColumns"
          :data="symbols"
          :loading="loading"
          :pagination="paginationState"
          remote
          :row-props="splitRowProps"
          @update:page="handlePageChange"
          @update:page-size="handlePageSizeChange"
          @update:sorter="handleSort"
        />
      </n-card>
    </template>

    <template #split-right>
      <crypto-symbol-detail-panel
        :row="selectedDetailRow"
        :interval="selectedInterval"
      />
    </template>

    <template #empty-detail>
      <n-empty description="点击左侧股票查看详情" class="empty-detail-placeholder" />
    </template>
  </symbols-panel-layout>

  <column-settings-drawer
    v-model:show="showColumnSettings"
    v-model:modelValue="scopePreferences"
    :title="columnSettingsTitle"
    :definitions="columnDefs"
    :loading="columnPrefsLoading"
    :saving="columnPrefsSaving"
    @save="handleSaveColumnPreferences"
  />
</template>

<script setup lang="ts">
defineOptions({ name: 'CryptoSymbolsPanel' })

import { computed, h, onMounted, ref } from 'vue'
import {
  NCard,
  NDataTable,
  NEmpty,
  NSelect,
  NSpace,
  NTag,
  useMessage,
} from 'naive-ui'
import CryptoSymbolsFilters from './CryptoSymbolsFilters.vue'
import CryptoSymbolDetailPanel from './CryptoSymbolDetailPanel.vue'
import type { NumericCondition, NumericConditionFieldOption } from '../../common/numericConditionFilterTypes'
import { symbolApi, type SymbolRow } from '@/api'
import ColumnSettingsDrawer from '../columns/ColumnSettingsDrawer.vue'
import { createCryptoColumnDefs } from './cryptoColumns'
import { useTableColumnPreferences } from '@/composables/symbols/useTableColumnPreferences'
import { usePanelViewMode } from '@/composables/symbols/usePanelViewMode'
import { useWatchlistTagFilter } from '@/composables/symbols/useWatchlistTagFilter'
import { useStrategyConditionsStore } from '@/stores/strategyConditions'
import { strategyConditionsApi } from '@/api/modules/strategy/strategyConditions'
import { useCryptoSymbolsQuery } from './useCryptoSymbolsQuery'
import SymbolsPanelLayout from '../shared/SymbolsPanelLayout.vue'

const message = useMessage()

const selectedInterval = ref<'1h' | '4h' | '1d'>('1h')
const intervalOptions = [
  { label: '1h', value: '1h' },
  { label: '4h', value: '4h' },
  { label: '1d', value: '1d' },
]

const searchQuery = ref('')
const showColumnSettings = ref(false)
const selectedDetailRow = ref<SymbolRow | null>(null)
const conditions = ref<NumericCondition[]>([])
const fieldOptions = ref<NumericConditionFieldOption[]>([])
const selectedStrategyIds = ref<string[]>([])
const hitLookup = ref<Map<string, Set<string>>>(new Map())

const { viewMode } = usePanelViewMode('crypto')

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

const baseColumnDefs = createCryptoColumnDefs({})
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
  tableColumns,
  splitColumns,
  load: loadColumnPreferences,
  save: saveColumnPreferences,
} = useTableColumnPreferences('crypto', columnDefs, viewMode)

const columnSettingsTitle = computed(() =>
  `Crypto Columns（${viewMode.value === 'split' ? '分栏视图' : '表格视图'}）`,
)

function splitRowProps(row: SymbolRow) {
  return {
    style: 'cursor: pointer',
    onClick: () => {
      selectedDetailRow.value = row
    },
  }
}

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
.crypto-symbols-panel { display: flex; flex-direction: column; gap: 18px; height: 100%; }
.split-left-card { height: 100%; }
.empty-detail-placeholder {
  align-items: center;
  display: flex;
  height: 100%;
  justify-content: center;
}
</style>
