<template>
  <div class="a-shares-panel">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">A 股数据</h2>
        <p class="panel-subtitle">TuShare 日线数据，本地库查询</p>
      </div>
      <n-space>
        <n-button :loading="syncing" @click="openSyncModal">
          <template #icon><n-icon><cloud-download-outline /></n-icon></template>
          同步
        </n-button>
        <n-button :loading="loading" @click="reload">
          <template #icon><n-icon><refresh-outline /></n-icon></template>
          刷新
        </n-button>
      </n-space>
    </div>

    <a-shares-filters
      v-model:search-query="searchQuery"
      v-model:selected-market="selectedMarket"
      v-model:selected-industry="selectedIndustry"
      v-model:price-mode="priceMode"
      v-model:pct-change-min="pctChangeMin"
      v-model:turnover-rate-min="turnoverRateMin"
      v-model:advanced-conditions="advancedConditions"
      :market-options="marketOptions"
      :industry-options="industryOptions"
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

    <a-shares-sync-modal
      v-model:show="showSyncModal"
      v-model:sync-date-range="syncDateRange"
      :syncing="syncing"
      :sync-range-label="syncRangeLabel"
      :sync-progress-visible="syncProgressVisible"
      :sync-status-label="syncStatusLabel"
      :sync-progress-count-label="syncProgressCountLabel"
      :can-confirm-sync="canConfirmSync"
      :sync-phase="syncPhase"
      :sync-percent="syncPercent"
      :sync-status="syncStatus"
      :sync-message="syncMessage"
      :data-date-range-label="dataDateRangeLabel"
      :data-date-range-loading="dataDateRangeLoading"
      @confirm="syncAShares"
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

import { computed, onMounted, ref } from 'vue'
import { NButton, NCard, NDataTable, NIcon, NSpace, useMessage } from 'naive-ui'
import { CloudDownloadOutline, RefreshOutline } from '@vicons/ionicons5'
import type { AShareRow } from '../../composables/useApi'
import AShareDetailDrawer from './a-shares/AShareDetailDrawer.vue'
import ASharesFilters from './a-shares/ASharesFilters.vue'
import ASharesSyncModal from './a-shares/ASharesSyncModal.vue'
import { createASharesColumns } from './a-shares/aSharesColumns'
import { useASharesQuery } from './a-shares/useASharesQuery'
import { useASharesSync } from './a-shares/useASharesSync'

const message = useMessage()
const {
  loading,
  rows,
  searchQuery,
  selectedMarket,
  selectedIndustry,
  priceMode,
  pctChangeMin,
  turnoverRateMin,
  advancedConditions,
  marketOptions,
  industryOptions,
  paginationState,
  reload,
  applyFilters,
  resetFilters,
  handlePriceModeChange,
  handlePageChange,
  handlePageSizeChange,
  handleSort,
} = useASharesQuery(message)

const {
  syncing,
  showSyncModal,
  syncDateRange,
  syncProgressVisible,
  syncStatusLabel,
  syncProgressCountLabel,
  canConfirmSync,
  syncRangeLabel,
  syncPhase,
  syncPercent,
  syncStatus,
  syncMessage,
  dataDateRangeLabel,
  dataDateRangeLoading,
  openSyncModal,
  syncAShares,
} = useASharesSync(message, reload)

const showDetailDrawer = ref(false)
const selectedDetailRow = ref<AShareRow | null>(null)

function handleViewDetail(row: AShareRow) {
  selectedDetailRow.value = row
  showDetailDrawer.value = true
}

const columns = computed(() => createASharesColumns({ onViewDetail: handleViewDetail, priceMode: priceMode.value }))

onMounted(() => {
  void reload()
})
</script>

<style scoped>
.a-shares-panel { display: flex; flex-direction: column; gap: 18px; }
.panel-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
.panel-title { margin: 0; font-size: 22px; line-height: 1.2; }
.panel-subtitle { margin: 6px 0 0; color: var(--color-text-secondary); }
.trend-up { color: var(--color-success); }
.trend-down { color: var(--color-error); }

@media (max-width: 960px) {
  .panel-header { flex-direction: column; }
}
</style>
