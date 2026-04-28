<template>
  <div class="a-shares-panel">
    <div class="panel-header">
      <div>
        <h2 class="panel-title">A 股数据</h2>
        <p class="panel-subtitle">TuShare 日线数据，本地库查询</p>
      </div>
      <n-space>
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
import { RefreshOutline } from '@vicons/ionicons5'
import type { AShareRow } from '@/api'
import AShareDetailDrawer from './a-shares/AShareDetailDrawer.vue'
import ASharesFilters from './a-shares/ASharesFilters.vue'
import { createASharesColumns } from './a-shares/aSharesColumns'
import { useASharesQuery } from './a-shares/useASharesQuery'

const message = useMessage()
const {
  loading,
  filterPresetsLoading,
  rows,
  filterPresets,
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

@media (max-width: 960px) {
  .panel-header { flex-direction: column; }
}
</style>
