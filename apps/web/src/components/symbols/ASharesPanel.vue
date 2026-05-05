<template>
  <div class="a-shares-panel">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">A 股数据</h2>
      </div>
      <n-space>
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

    <strategy-condition-picker
      target-type="a-share"
      @run="handleStrategyRun"
    />

    <a-shares-filters
      v-model:search-query="searchQuery"
      v-model:selected-market="selectedMarket"
      v-model:selected-industry="selectedIndustry"
      v-model:selected-watchlist-ids="selectedWatchlistIds"
      v-model:price-mode="priceMode"
      v-model:pct-change-min="pctChangeMin"
      v-model:turnover-rate-min="turnoverRateMin"
      v-model:advanced-conditions="advancedConditions"
      :market-options="marketOptions"
      :industry-options="industryOptions"
      :watchlist-options="watchlistOptions"
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

    <n-card :bordered="false">
      <n-data-table
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

    <column-settings-drawer
      v-model:show="showColumnSettings"
      v-model:modelValue="scopePreferences"
      title="A 股 Columns"
      :definitions="columnDefs"
      :loading="columnPrefsLoading"
      :saving="columnPrefsSaving"
      @save="handleSaveColumnPreferences"
    />

    <a-share-detail-drawer
      v-model:show="showDetailDrawer"
      :row="selectedDetailRow"
      :price-mode="priceMode"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesPanel' })

import { computed, h, onMounted, ref } from 'vue'
import { NButton, NCard, NDataTable, NIcon, NSpace, NTag, useMessage } from 'naive-ui'
import { RefreshOutline, SettingsOutline } from '@vicons/ionicons5'
import type { AShareRow } from '@/api'
import AShareDetailDrawer from './a-shares/AShareDetailDrawer.vue'
import ASharesFilters from './a-shares/ASharesFilters.vue'
import { createASharesColumnDefs } from './a-shares/aSharesColumns'
import { useASharesQuery } from './a-shares/useASharesQuery'
import ColumnSettingsDrawer from './ColumnSettingsDrawer.vue'
import { useSymbolColumnPreferences } from '@/composables/symbols/useSymbolColumnPreferences'
import StrategyConditionPicker from './common/StrategyConditionPicker.vue'
import { useStrategyConditionsStore } from '@/stores/strategyConditions'

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
  marketOptions,
  industryOptions,
  paginationState,
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

const showDetailDrawer = ref(false)
const showColumnSettings = ref(false)
const selectedDetailRow = ref<AShareRow | null>(null)

function handleViewDetail(row: AShareRow) {
  selectedDetailRow.value = row
  showDetailDrawer.value = true
}

const strategyStore = useStrategyConditionsStore()
const strategyRunResults = ref<Map<string, any>>(new Map())

function handleStrategyRun(results: Map<string, any>) {
  strategyRunResults.value = results
}

const columnDefs = computed(() => {
  const baseDefs = createASharesColumnDefs({ onViewDetail: handleViewDetail, priceMode: priceMode.value })
  // 添加买入信号列
  baseDefs.push({
    title: '买入信号',
    key: 'buySignal',
    width: 200,
    defaultVisible: true,
    render: (row: AShareRow) => {
      const hits: string[] = []
      strategyRunResults.value.forEach((result, conditionId) => {
        const condition = strategyStore.conditions.find(c => c.id === conditionId)
        if (condition && result.hits.some((h: any) => h.tsCode === row.tsCode)) {
          hits.push(condition.name)
        }
      })
      if (hits.length === 0) return '-'
      return h(NSpace, { size: 4 }, {
        default: () => hits.map(name => h(NTag, { type: 'success', size: 'small' }, { default: () => name })),
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
</script>

<style scoped>
.a-shares-panel { display: flex; flex-direction: column; gap: 18px; }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.panel-title { margin: 0; font-size: 22px; line-height: 1.2; }
.panel-subtitle { margin: 6px 0 0; color: var(--color-text-secondary); }

@media (max-width: 960px) {
  .panel-header { flex-direction: column; }
}
</style>
