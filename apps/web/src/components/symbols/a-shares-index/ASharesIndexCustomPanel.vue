<template>
  <div class="a-shares-index-custom-panel">
    <n-card :bordered="false">
      <div class="toolbar">
        <n-input
          v-model:value="searchQuery"
          placeholder="搜索指数名称"
          clearable
          class="search-input"
          @keyup.enter="applySearch"
        />
        <n-button :loading="loading" @click="reload">刷新</n-button>
        <n-button @click="showColumnSettings = true">列设置</n-button>
      </div>

      <n-data-table
        data-testid="a-shares-custom-index-table"
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
      title="我的指数列设置"
      :definitions="columnDefs"
      :loading="columnPrefsLoading"
      :saving="columnPrefsSaving"
      @save="handleSaveColumnPreferences"
    />

    <a-shares-index-kline-modal
      v-model:show="showKlineModal"
      :row="selectedKlineRow"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesIndexCustomPanel' })

import { computed, onActivated, onMounted, ref } from 'vue'
import { NButton, NCard, NDataTable, NInput, useDialog, useMessage } from 'naive-ui'
import ColumnSettingsDrawer from '../ColumnSettingsDrawer.vue'
import ASharesIndexKlineModal from './ASharesIndexKlineModal.vue'
import { createCustomIndexColumnDefs } from './customIndexColumns'
import { useCustomIndexQuery } from './useCustomIndexQuery'
import { useCustomIndexSse } from './useCustomIndexSse'
import { useTableColumnPreferences } from '@/composables/symbols/useTableColumnPreferences'
import { customIndexApi, type CustomIndexLatestRow } from '@/api/modules/market/customIndex'
import type { IndexLatestRow } from './types'

const emit = defineEmits<{
  (
    e: 'jump-to-members',
    payload: { tsCode: string; name: string; category: 'custom'; customIndexId: string },
  ): void
  (e: 'edit', row: CustomIndexLatestRow): void
}>()

const message = useMessage()
const dialog = useDialog()

const {
  loading,
  rows,
  searchQuery,
  paginationState,
  reload,
  applySearch,
  handlePageChange,
  handlePageSizeChange,
  handleSort,
  patchRow,
} = useCustomIndexQuery(message)

const { subscribe: subscribeSse } = useCustomIndexSse((event) => {
  const id = sseTargetId.value
  if (!id) return
  patchRow(id, {
    status: event.status,
    computeProgress: event.progress,
    lastError: event.last_error ?? null,
  })
  if (event.status === 'ready' || event.status === 'failed') {
    void reload()
    sseTargetId.value = null
  }
})

const sseTargetId = ref<string | null>(null)

function startSseIfNeeded(row: CustomIndexLatestRow) {
  if (row.status === 'pending' || row.status === 'computing') {
    sseTargetId.value = row.id
    void subscribeSse(row.id)
  }
}

const columnDefs = computed(() =>
  createCustomIndexColumnDefs({
    onJumpToMembers: (row) => {
      emit('jump-to-members', {
        tsCode: row.tsCode,
        name: row.name,
        category: 'custom',
        customIndexId: row.id,
      })
    },
    onEdit: (row) => emit('edit', row),
    onDelete: (row) => confirmDelete(row),
    onRecompute: (row) => void handleRecompute(row),
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
} = useTableColumnPreferences('aSharesIndexCustom', columnDefs, 'table')

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
const selectedKlineRow = ref<IndexLatestRow | null>(null)

function toKlineRow(row: CustomIndexLatestRow): IndexLatestRow {
  return {
    id: row.id,
    tsCode: row.tsCode,
    name: row.name,
    category: 'custom',
    tradeDate: row.tradeDate ?? '',
    close: row.close ?? 0,
    pctChange: row.pctChange,
    vol: row.vol,
    amount: row.amount,
    totalMvWan: null,
    pe: null,
    pb: null,
    count: row.count,
    netAmount: row.netAmount,
    netAmount5d: row.netAmount5d,
    netAmount10d: row.netAmount10d,
    netAmount20d: row.netAmount20d,
    buyLgAmount: row.buyLgAmount,
    buyMdAmount: row.buyMdAmount,
    buySmAmount: row.buySmAmount,
  }
}

function rowProps(row: CustomIndexLatestRow) {
  return {
    style: row.status === 'ready' ? 'cursor: pointer;' : undefined,
    onClick: () => {
      if (row.status !== 'ready') return
      selectedKlineRow.value = toKlineRow(row)
      showKlineModal.value = true
    },
  }
}

async function handleRecompute(row: CustomIndexLatestRow) {
  try {
    await customIndexApi.recompute(row.id)
    patchRow(row.id, { status: 'computing', computeProgress: 0, lastError: null })
    startSseIfNeeded({ ...row, status: 'computing' })
    message.success('已触发重算')
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '重试失败')
  }
}

function confirmDelete(row: CustomIndexLatestRow) {
  dialog.warning({
    title: '删除指数',
    content: `确定删除「${row.name}」？此操作不可撤销。`,
    positiveText: '删除',
    negativeText: '取消',
    onPositiveClick: async () => {
      try {
        await customIndexApi.delete(row.id)
        message.success('已删除')
        await reload()
      } catch (err: unknown) {
        message.error(err instanceof Error ? err.message : '删除失败')
      }
    },
  })
}

const RELOAD_THROTTLE_MS = 60_000
const lastLoadedAt = ref(0)

async function reloadAndMarkLoaded() {
  await reload()
  lastLoadedAt.value = Date.now()
  for (const row of rows.value) {
    if (row.status === 'pending' || row.status === 'computing') {
      startSseIfNeeded(row)
      break
    }
  }
}

defineExpose({
  reload: reloadAndMarkLoaded,
  onIndexSaved: (payload: { id: string; status: string }) => {
    void reloadAndMarkLoaded()
    if (payload.status === 'pending' || payload.status === 'computing') {
      sseTargetId.value = payload.id
      void subscribeSse(payload.id)
    }
  },
})

onMounted(() => {
  void reloadAndMarkLoaded()
  void loadColumnPreferences().catch((err: unknown) => {
    message.error(err instanceof Error ? err.message : String(err))
  })
})

onActivated(() => {
  if (Date.now() - lastLoadedAt.value < RELOAD_THROTTLE_MS) return
  void reloadAndMarkLoaded()
})
</script>

<style scoped>
.a-shares-index-custom-panel {
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
</style>
