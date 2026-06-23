<template>
  <div class="a-shares-index-ths-panel">
    <n-card :bordered="false">
      <div class="toolbar">
        <n-input
          v-model:value="searchQuery"
          placeholder="搜索指数名称"
          clearable
          class="search-input"
          @keyup.enter="applySearch"
        />
        <n-select
          :value="selectedType"
          :options="typeOptions"
          class="type-select"
          @update:value="onTypeChange"
        />
        <n-button :loading="loading" @click="reload">刷新</n-button>
        <n-button @click="showColumnSettings = true">列设置</n-button>
      </div>

      <n-data-table
        data-testid="a-shares-index-table"
        :columns="tableColumns"
        :data="rows"
        :loading="loading"
        :pagination="paginationState"
        :row-props="rowProps"
        remote
        @update:page="handlePageChange"
        @update:page-size="handlePageSizeChange"
        @update:sorter="handleSort"
      />
    </n-card>

    <column-settings-drawer
      v-model:show="showColumnSettings"
      v-model:modelValue="scopePreferences"
      title="A 股指数列设置"
      :definitions="columnDefs"
      :loading="columnPrefsLoading"
      :saving="columnPrefsSaving"
      @save="handleSaveColumnPreferences"
    />

    <a-shares-index-kline-modal
      v-model:show="showKlineModal"
      :row="selectedRow"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesIndexThsPanel' })

import { computed, onActivated, onMounted, ref } from 'vue'
import { NButton, NCard, NDataTable, NInput, NSelect, useMessage } from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import ColumnSettingsDrawer from '../ColumnSettingsDrawer.vue'
import ASharesIndexKlineModal from './ASharesIndexKlineModal.vue'
import { createASharesIndexColumnDefs } from './aSharesIndexColumns'
import { useASharesIndexQuery } from './useASharesIndexQuery'
import { useSymbolColumnPreferences } from '@/composables/symbols/useSymbolColumnPreferences'
import type { IndexLatestRow } from './types'
import type { IndexTypeFilter } from './useASharesIndexQuery'

const emit = defineEmits<{
  (e: 'jump-to-members', payload: { tsCode: string; name: string; category: string }): void
}>()

const message = useMessage()
const {
  loading,
  rows,
  searchQuery,
  selectedType,
  paginationState,
  reload,
  applyTypeFilter,
  applySearch,
  handlePageChange,
  handlePageSizeChange,
  handleSort,
} = useASharesIndexQuery(message)

const typeOptions: SelectOption[] = [
  { label: '全部', value: 'all' },
  { label: '大盘', value: 'market' },
  { label: '行业', value: 'industry' },
  { label: '概念', value: 'concept' },
]

// n-select 的 @update:value 回调值是联合类型；在此收口到 IndexTypeFilter 再下发。
function onTypeChange(value: string | number | boolean | null) {
  selectedType.value = value as IndexTypeFilter
  applyTypeFilter()
}

const columnDefs = computed(() =>
  createASharesIndexColumnDefs({
    showValuation: false,
    onJumpToMembers: (row) => {
      emit('jump-to-members', { tsCode: row.tsCode, name: row.name, category: row.category })
    },
  }),
)
const showColumnSettings = ref(false)

const {
  loading: columnPrefsLoading,
  saving: columnPrefsSaving,
  scopePreferences,
  tableColumns,
  load: loadColumnPreferences,
  save: saveColumnPreferences,
} = useSymbolColumnPreferences('aSharesIndex', columnDefs, 'table')

async function handleSaveColumnPreferences() {
  try {
    await saveColumnPreferences()
    showColumnSettings.value = false
    message.success('列设置已保存')
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

const showKlineModal = ref(false)
const selectedRow = ref<IndexLatestRow | null>(null)

function rowProps(row: IndexLatestRow) {
  return {
    style: 'cursor: pointer;',
    onClick: () => {
      selectedRow.value = row
      showKlineModal.value = true
    },
  }
}

// 本面板懒挂在 sub-tab（同花顺/申万）内，且整体位于 SymbolsView 顶层 <keep-alive>。
// 首挂载时 onActivated 不触发（激活时机已过）→ 首屏用 onMounted；
// 从其它顶层 Tab 切回时 onActivated 刷新行情（参考 ASharesPanel / vue3-frontend.md）。
onMounted(() => {
  void reload()
  void loadColumnPreferences().catch((err: unknown) => {
    message.error(err instanceof Error ? err.message : String(err))
  })
})

onActivated(() => {
  void reload()
})
</script>

<style scoped>
.a-shares-index-ths-panel {
  height: 100%;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.search-input {
  max-width: 260px;
}

.type-select {
  width: 140px;
}
</style>
