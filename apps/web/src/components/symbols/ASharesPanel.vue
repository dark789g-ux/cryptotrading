<template>
  <symbols-panel-layout
    class="a-shares-panel"
    scope="aShares"
    :loading="loading"
    v-model:showColumnSettings="showColumnSettings"
    :show-empty-detail="!selectedDetailRow"
    @refresh="reload"
  >
    <template #filters>
      <a-shares-filters
        v-model:search-query="searchQuery"
        v-model:selected-market="selectedMarket"
        v-model:selected-industry="selectedIndustry"
        v-model:selected-watchlist-ids="selectedWatchlistIds"
        v-model:selected-strategy-ids="selectedStrategyIds"
        v-model:price-mode="priceMode"
        v-model:pct-change-min="pctChangeMin"
        v-model:turnover-rate-min="turnoverRateMin"
        v-model:advanced-conditions="advancedConditions"
        :market-options="marketOptions"
        :industry-options="industryOptions"
        :watchlist-options="watchlistOptions"
        :strategy-options="strategyFilterOptions"
        :filter-presets="filterPresets"
        :filter-presets-loading="filterPresetsLoading"
        @apply="applyFilters"
        @reset="resetFilters"
        @update:price-mode="handlePriceModeChange"
        @refresh-filter-presets="loadFilterPresets"
        @create-filter-preset="createFilterPreset"
        @overwrite-filter-preset="overwriteFilterPreset"
        @rename-filter-preset="renameFilterPreset"
        @delete-filter-preset="deleteFilterPreset"
        @apply-filter-preset="applyFilterPreset"
      />
    </template>

    <template #table>
      <n-card :bordered="false">
        <n-data-table
          data-testid="full-table"
          :columns="columns"
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
          :columns="simpleColumns"
          :data="rows"
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
      <a-share-detail-panel
        :row="selectedDetailRow"
        :price-mode="priceMode"
      />
    </template>

    <template #empty-detail>
      <n-empty description="点击左侧股票查看详情" class="empty-detail-placeholder" />
    </template>
  </symbols-panel-layout>

  <column-settings-drawer
    v-model:show="showColumnSettings"
    v-model:modelValue="scopePreferences"
    title="A 股 Columns"
    :definitions="columnDefs"
    :loading="columnPrefsLoading"
    :saving="columnPrefsSaving"
    @save="handleSaveColumnPreferences"
  />

</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesPanel' })

import { computed, h, onActivated, onMounted, ref } from 'vue'
import { NCard, NDataTable, NEmpty, NSpace, NTag, useMessage, type DataTableColumns } from 'naive-ui'
import type { AShareRow } from '@/api'
import AShareDetailPanel from './a-shares/AShareDetailPanel.vue'
import ASharesFilters from './a-shares/ASharesFilters.vue'
import { createASharesColumnDefs } from './a-shares/aSharesColumns'
import { useASharesQuery } from './a-shares/useASharesQuery'
import ColumnSettingsDrawer from './ColumnSettingsDrawer.vue'
import { useSymbolColumnPreferences } from '@/composables/symbols/useSymbolColumnPreferences'
import { useStrategyConditionsStore } from '@/stores/strategyConditions'
import { strategyConditionsApi } from '@/api/modules/strategy/strategyConditions'
import SymbolsPanelLayout from './SymbolsPanelLayout.vue'
import { formatNumber } from './a-shares/aSharesFormatters'

const message = useMessage()
const {
  loading,
  filterPresetsLoading,
  rows,
  filterPresets,
  searchQuery,
  selectedMarket,
  selectedIndustry,
  selectedWatchlistIds,
  watchlistOptions,
  priceMode,
  pctChangeMin,
  turnoverRateMin,
  advancedConditions,
  selectedStrategyIds,
  marketOptions,
  industryOptions,
  paginationState,
  scoresMap,
  scoresLoading,
  reload,
  loadFilterPresets,
  applyFilters,
  resetFilters,
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
  for (const condition of strategyStore.conditions) {
    if (condition.targetType !== 'a-share') continue
    const status = strategyStore.runStatuses.get(condition.id)
    if (!status || status.freshness !== 'fresh') continue
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
  columns,
  load: loadColumnPreferences,
  save: saveColumnPreferences,
} = useSymbolColumnPreferences('aShares', columnDefs)

const simpleColumns = computed<DataTableColumns<AShareRow>>(() => {
  const priceSuffix = priceMode.value === 'raw' ? '原始' : '前复权'
  return [
    { title: '名称', key: 'name', sorter: true, render: row => row.name },
    { title: '代码', key: 'tsCode', sorter: true, render: row => row.tsCode },
    {
      title: `现价(${priceSuffix})`,
      key: 'close',
      sorter: true,
      render: row => formatNumber(row.close, 2),
    },
  ]
})

function splitRowProps(row: AShareRow) {
  return {
    style: 'cursor: pointer',
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
  await strategyStore.fetchConditions('a-share')
  await strategyStore.fetchLastRunStatus()
  await loadHitLookup()
})
</script>

<style scoped>
.a-shares-panel {
  height: 100%;
}

.split-left-card {
  height: 100%;
}

.empty-detail-placeholder {
  align-items: center;
  display: flex;
  height: 100%;
  justify-content: center;
}
</style>
