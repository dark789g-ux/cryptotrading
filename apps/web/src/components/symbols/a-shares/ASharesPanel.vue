<template>
  <symbols-panel-layout
    class="a-shares-panel"
    scope="aShares"
    v-model:view-mode="viewMode"
    :loading="loading"
    :show-empty-detail="!selectedDetailRow"
    @refresh="reload"
  >
    <template #filters>
      <a-shares-filters
        v-model:search-query="searchQuery"
        v-model:selected-market="selectedMarket"
        v-model:selected-sw-industry-l1-code="selectedSwIndustryL1Code"
        v-model:selected-sw-industry-l2-code="selectedSwIndustryL2Code"
        v-model:selected-sw-industry-l3-code="selectedSwIndustryL3Code"
        v-model:selected-watchlist-ids="selectedWatchlistIds"
        v-model:selected-strategy-ids="selectedStrategyIds"
        v-model:price-mode="priceMode"
        v-model:pct-change-min="pctChangeMin"
        v-model:turnover-rate-min="turnoverRateMin"
        v-model:advanced-conditions="advancedConditions"
        :market-options="marketOptions"
        :sw-industry-l1-options="swIndustryL1Options"
        :sw-industry-l2-options="swIndustryL2Options"
        :sw-industry-l3-options="swIndustryL3Options"
        :watchlist-options="watchlistOptions"
        :strategy-options="strategyFilterOptions"
        :filter-presets="filterPresets"
        :filter-presets-loading="filterPresetsLoading"
        :index-filter="indexFilter"
        @apply="applyFilters"
        @reset="resetFilters"
        @update:price-mode="handlePriceModeChange"
        @update:show-column-settings="(val: boolean) => showColumnSettings = val"
        @refresh-filter-presets="loadFilterPresets"
        @create-filter-preset="createFilterPreset"
        @overwrite-filter-preset="overwriteFilterPreset"
        @rename-filter-preset="renameFilterPreset"
        @delete-filter-preset="deleteFilterPreset"
        @apply-filter-preset="applyFilterPreset"
        @clear-index-filter="clearIndexFilter"
      />
    </template>

    <template #table>
      <n-card :bordered="false">
        <n-data-table
          data-testid="full-table"
          :columns="tableColumns"
          :scroll-x="tableScrollX"
          :data="rows"
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
          :scroll-x="splitScrollX"
          :data="rows"
          :loading="loading"
          :pagination="splitPaginationState"
          remote
          :row-props="splitRowProps"
          @update:page="handlePageChange"
          @update:page-size="handlePageSizeChange"
          @update:sorter="handleSort"
        />
      </n-card>
    </template>

    <template #split-right>
      <n-card :bordered="false" class="split-right-card">
        <a-share-detail-panel
          :row="selectedDetailRow"
          :price-mode="priceMode"
        />
      </n-card>
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
defineOptions({ name: 'ASharesPanel' })

import { computed, h, onActivated, onMounted, ref } from 'vue'
import { NCard, NDataTable, NEmpty, NSpace, NTag, useMessage } from 'naive-ui'
import type { AShareRow } from '@/api'
import AShareDetailPanel from './AShareDetailPanel.vue'
import ASharesFilters from './ASharesFilters.vue'
import { createASharesColumnDefs } from './aSharesColumns'
import { useASharesQuery } from './useASharesQuery'
import ColumnSettingsDrawer from '../columns/ColumnSettingsDrawer.vue'
import { useTableColumnPreferences } from '@/composables/symbols/useTableColumnPreferences'
import { useTableScrollX } from '@/composables/symbols/useTableScrollX'
import { usePanelViewMode } from '@/composables/symbols/usePanelViewMode'
import { useStrategyConditionsStore } from '@/stores/strategyConditions'
import { strategyConditionsApi } from '@/api/modules/strategy/strategyConditions'
import SymbolsPanelLayout from '../shared/SymbolsPanelLayout.vue'

const message = useMessage()
const {
  loading,
  filterPresetsLoading,
  rows,
  filterPresets,
  searchQuery,
  selectedMarket,
  selectedSwIndustryL1Code,
  selectedSwIndustryL2Code,
  selectedSwIndustryL3Code,
  selectedWatchlistIds,
  watchlistOptions,
  priceMode,
  pctChangeMin,
  turnoverRateMin,
  advancedConditions,
  selectedStrategyIds,
  indexFilter,
  marketOptions,
  swIndustryL1Options,
  swIndustryL2Options,
  swIndustryL3Options,
  paginationState,
  splitPaginationState,
  scoresMap,
  scoresLoading,
  reload,
  loadFilterPresets,
  applyFilters,
  resetFilters,
  applyIndexFilter,
  clearIndexFilter,
  createFilterPreset,
  overwriteFilterPreset,
  renameFilterPreset,
  deleteFilterPreset,
  applyFilterPreset,
  handlePriceModeChange,
  handlePageChange,
  handlePageSizeChange,
  handleSort,
} = useASharesQuery(message)

const showColumnSettings = ref(false)
const selectedDetailRow = ref<AShareRow | null>(null)
const hitLookup = ref<Map<string, Set<string>>>(new Map())

const { viewMode } = usePanelViewMode('aShares')

const strategyStore = useStrategyConditionsStore()

const strategyFilterOptions = computed(() => {
  return strategyStore.conditions
    .filter(c => c.targetType === 'a-share')
    .filter(c => {
      const status = strategyStore.runStatuses.get(c.id)
      return status && status.freshness === 'fresh'
    })
    .map(c => ({
      label: `${c.name} (${strategyStore.runStatuses.get(c.id)?.totalHits ?? 0} 命中)`,
      value: c.id,
    }))
})

async function loadHitLookup() {
  const newLookup = new Map<string, Set<string>>()
  const freshConditions = strategyStore.conditions.filter(c => {
    if (c.targetType !== 'a-share') return false
    const status = strategyStore.runStatuses.get(c.id)
    return status && status.freshness === 'fresh'
  })
  const results = await Promise.all(
    freshConditions.map(condition =>
      strategyConditionsApi
        .getRunResult(condition.id)
        .then(result => ({ condition, result }))
        .catch(() => null),
    ),
  )
  for (const entry of results) {
    if (!entry) continue
    const { condition, result } = entry
    for (const hit of result.hits) {
      const names = newLookup.get(hit.tsCode) ?? new Set<string>()
      names.add(condition.name)
      newLookup.set(hit.tsCode, names)
    }
  }
  hitLookup.value = newLookup
}

const columnDefs = computed(() => {
  const baseDefs = createASharesColumnDefs({
    priceMode: priceMode.value,
    scoresMap,
    scoresLoading,
  })
  baseDefs.push({
    title: '买入信号',
    key: 'buySignal',
    width: 200,
    defaultVisible: true,
    render: (row: AShareRow) => {
      const matchedNames = hitLookup.value.get(row.tsCode)
      if (!matchedNames || matchedNames.size === 0) return '-'
      return h(NSpace, { size: 4 }, {
        default: () => [...matchedNames].map(name =>
          h(NTag, { type: 'success', size: 'small' }, { default: () => name })),
      })
    },
  })
  return baseDefs
})

const {
  loading: columnPrefsLoading,
  saving: columnPrefsSaving,
  scopePreferences,
  tableColumns,
  splitColumns,
  load: loadColumnPreferences,
  save: saveColumnPreferences,
} = useTableColumnPreferences('aShares', columnDefs, viewMode)

const tableScrollX = useTableScrollX(tableColumns)
const splitScrollX = useTableScrollX(splitColumns)

const columnSettingsTitle = computed(() =>
  `A 股 Columns（${viewMode.value === 'split' ? '分栏视图' : '表格视图'}）`,
)

function splitRowProps(row: AShareRow) {
  const isSelected = selectedDetailRow.value?.tsCode === row.tsCode
  return {
    style: 'cursor: pointer;',
    class: isSelected ? 'split-row-selected' : '',
    onClick: () => {
      selectedDetailRow.value = row
    },
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
  void reload()
  void loadColumnPreferences().catch((err: unknown) => {
    message.error(err instanceof Error ? err.message : String(err))
  })
})

// keep-alive 场景：onActivated 在首次挂载和每次从缓存激活时都会触发，
// 确保从策略条件管理切回后 hitLookup 能感知最新运行结果
onActivated(async () => {
  await Promise.all([
    strategyStore.fetchConditions('a-share'),
    strategyStore.fetchLastRunStatus(),
  ])
  await loadHitLookup()
})

defineExpose({
  applyIndexFilter,
})
</script>

<style scoped>
.a-shares-panel {
  height: 100%;
}

.split-left-card,
.split-right-card {
  height: 100%;
}

:deep(.split-row-selected td) {
  background: color-mix(in srgb, var(--color-primary) 12%, transparent) !important;
}

.empty-detail-placeholder {
  align-items: center;
  display: flex;
  height: 100%;
  justify-content: center;
}
</style>
