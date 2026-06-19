<template>
  <symbols-panel-layout
    class="us-stocks-panel"
    scope="usStocks"
    v-model:view-mode="viewMode"
    :loading="loading"
    :show-empty-detail="!selectedDetailRow"
    @refresh="reload"
  >
    <template #header-actions>
      <n-space>
        <n-button :loading="syncing" @click="handleSync">
          <template #icon><n-icon><cloud-download-outline /></n-icon></template>
          同步
        </n-button>
        <n-button secondary @click="showSymbolManage = true">
          <template #icon><n-icon><list-outline /></n-icon></template>
          标的管理
        </n-button>
      </n-space>
    </template>

    <template #filters>
      <us-stocks-filters
        v-model:search-query="searchQuery"
        v-model:selected-theme="selectedTheme"
        v-model:selected-stock-type="selectedStockType"
        v-model:price-mode="priceMode"
        v-model:pct-change-min="pctChangeMin"
        v-model:advanced-conditions="advancedConditions"
        :theme-options="themeOptions"
        :stock-type-options="stockTypeOptions"
        @apply="applyFilters"
        @reset="resetFilters"
        @update:price-mode="handlePriceModeChange"
        @update:show-column-settings="(val: boolean) => showColumnSettings = val"
      />
    </template>

    <template #table>
      <n-card :bordered="false">
        <n-data-table
          data-testid="full-table"
          :columns="tableColumns"
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
          :data="rows"
          :loading="loading"
          :pagination="paginationState"
          :row-props="compactRowProps"
          remote
          @update:page="handlePageChange"
          @update:page-size="handlePageSizeChange"
          @update:sorter="handleSort"
        />
      </n-card>
    </template>

    <template #split-right>
      <us-stock-detail-panel
        :row="selectedDetailRow"
        :price-mode="priceMode"
      />
    </template>

    <template #empty-detail>
      <div class="empty-detail-placeholder">
        <n-empty description="点击左侧股票查看详情" />
      </div>
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

  <us-symbol-manage-modal
    v-model:show="showSymbolManage"
    @saved="reload"
  />

  <us-sync-progress-modal
    v-model:show="showSyncProgress"
    :job-id="syncJobId"
    @done="handleSyncDone"
  />
</template>

<script setup lang="ts">
defineOptions({ name: 'UsStocksPanel' })

import { computed, onMounted, ref } from 'vue'
import { NButton, NCard, NDataTable, NEmpty, NIcon, NSpace, useMessage } from 'naive-ui'
import {
  CloudDownloadOutline,
  ListOutline,
} from '@vicons/ionicons5'
import { usStocksApi, type JobStatus, type UsStockRow } from '@/api'
import SymbolsPanelLayout from './SymbolsPanelLayout.vue'
import UsStockDetailPanel from './us-stocks/UsStockDetailPanel.vue'
import UsStocksFilters from './us-stocks/UsStocksFilters.vue'
import UsSymbolManageModal from './us-stocks/UsSymbolManageModal.vue'
import UsSyncProgressModal from './us-stocks/UsSyncProgressModal.vue'
import { createUsStocksColumnDefs } from './us-stocks/usStocksColumns'
import { useUsStocksQuery } from './us-stocks/useUsStocksQuery'
import ColumnSettingsDrawer from './ColumnSettingsDrawer.vue'
import { useSymbolColumnPreferences } from '@/composables/symbols/useSymbolColumnPreferences'
import { usePanelViewMode } from '@/composables/symbols/usePanelViewMode'

const message = useMessage()
const {
  loading,
  rows,
  searchQuery,
  selectedTheme,
  selectedStockType,
  priceMode,
  pctChangeMin,
  advancedConditions,
  themeOptions,
  stockTypeOptions,
  paginationState,
  reload,
  applyFilters,
  resetFilters,
  handlePriceModeChange,
  handlePageChange,
  handlePageSizeChange,
  handleSort,
} = useUsStocksQuery(message)

const showColumnSettings = ref(false)
const showSymbolManage = ref(false)
const showSyncProgress = ref(false)
const selectedDetailRow = ref<UsStockRow | null>(null)
const syncing = ref(false)
const syncJobId = ref<string | null>(null)

const { viewMode } = usePanelViewMode('usStocks')

const columnDefs = computed(() =>
  createUsStocksColumnDefs({
    priceMode: priceMode.value,
  }),
)

const {
  loading: columnPrefsLoading,
  saving: columnPrefsSaving,
  scopePreferences,
  tableColumns,
  splitColumns,
  load: loadColumnPreferences,
  save: saveColumnPreferences,
} = useSymbolColumnPreferences('usStocks', columnDefs, viewMode)

const columnSettingsTitle = computed(() =>
  `美股 Columns（${viewMode.value === 'split' ? '分栏视图' : '表格视图'}）`,
)

function compactRowProps(row: UsStockRow) {
  return {
    style: 'cursor: pointer;',
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

async function handleSync() {
  syncing.value = true
  try {
    const { jobId } = await usStocksApi.sync()
    syncJobId.value = jobId
    showSyncProgress.value = true
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    syncing.value = false
  }
}

function handleSyncDone(state: JobStatus) {
  if (state === 'success') {
    void reload()
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
.us-stocks-panel { height: 100%; }
.split-left-card { height: 100%; }
.empty-detail-placeholder {
  align-items: center;
  display: flex;
  flex: 1;
  height: 100%;
  justify-content: center;
  min-height: 320px;
}
</style>
