<template>
  <div class="us-stocks-panel">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">美股</h2>
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
        <n-button :loading="syncing" @click="handleSync">
          <template #icon><n-icon><cloud-download-outline /></n-icon></template>
          同步
        </n-button>
        <n-button secondary @click="showSymbolManage = true">
          <template #icon><n-icon><list-outline /></n-icon></template>
          标的管理
        </n-button>
      </n-space>
    </div>

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
      title="美股 Columns"
      :definitions="columnDefs"
      :loading="columnPrefsLoading"
      :saving="columnPrefsSaving"
      @save="handleSaveColumnPreferences"
    />

    <us-stock-detail-drawer
      v-model:show="showDetailDrawer"
      :row="selectedDetailRow"
      :price-mode="priceMode"
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
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'UsStocksPanel' })

import { computed, onMounted, ref } from 'vue'
import { NButton, NCard, NDataTable, NIcon, NSpace, useMessage } from 'naive-ui'
import {
  CloudDownloadOutline,
  ListOutline,
  RefreshOutline,
  SettingsOutline,
} from '@vicons/ionicons5'
import { usStocksApi, type JobStatus, type UsStockRow } from '@/api'
import UsStockDetailDrawer from './us-stocks/UsStockDetailDrawer.vue'
import UsStocksFilters from './us-stocks/UsStocksFilters.vue'
import UsSymbolManageModal from './us-stocks/UsSymbolManageModal.vue'
import UsSyncProgressModal from './us-stocks/UsSyncProgressModal.vue'
import { createUsStocksColumnDefs } from './us-stocks/usStocksColumns'
import { useUsStocksQuery } from './us-stocks/useUsStocksQuery'
import ColumnSettingsDrawer from './ColumnSettingsDrawer.vue'
import { useSymbolColumnPreferences } from '@/composables/symbols/useSymbolColumnPreferences'

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

const showDetailDrawer = ref(false)
const showColumnSettings = ref(false)
const showSymbolManage = ref(false)
const showSyncProgress = ref(false)
const selectedDetailRow = ref<UsStockRow | null>(null)
const syncing = ref(false)
const syncJobId = ref<string | null>(null)

function handleViewDetail(row: UsStockRow) {
  selectedDetailRow.value = row
  showDetailDrawer.value = true
}

const columnDefs = computed(() =>
  createUsStocksColumnDefs({
    onViewDetail: handleViewDetail,
    priceMode: priceMode.value,
  }),
)

const {
  loading: columnPrefsLoading,
  saving: columnPrefsSaving,
  scopePreferences,
  columns,
  load: loadColumnPreferences,
  save: saveColumnPreferences,
} = useSymbolColumnPreferences('usStocks', columnDefs)

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
.us-stocks-panel { display: flex; flex-direction: column; gap: 18px; }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.panel-title { margin: 0; font-size: 22px; line-height: 1.2; }

@media (max-width: 960px) {
  .panel-header { flex-direction: column; }
}
</style>
