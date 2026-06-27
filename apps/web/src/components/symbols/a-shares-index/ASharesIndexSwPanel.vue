<template>
  <div class="a-shares-index-sw-panel">
    <n-card :bordered="false">
      <div class="toolbar">
        <n-radio-group
          :value="activeLevel"
          class="level-radio"
          @update:value="onLevelChange"
        >
          <n-radio-button :value="1">一级</n-radio-button>
          <n-radio-button :value="2">二级</n-radio-button>
          <n-radio-button :value="3">三级</n-radio-button>
        </n-radio-group>
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
        data-testid="a-shares-index-sw-table"
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
      title="申万指数列设置"
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
defineOptions({ name: 'ASharesIndexSwPanel' })

import { computed, onActivated, onMounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NInput,
  NRadioButton,
  NRadioGroup,
  useMessage,
} from 'naive-ui'
import ColumnSettingsDrawer from '../ColumnSettingsDrawer.vue'
import ASharesIndexKlineModal from './ASharesIndexKlineModal.vue'
import { createASharesIndexColumnDefs } from './aSharesIndexColumns'
import { useASharesIndexQuery } from './useASharesIndexQuery'
import { useTableColumnPreferences } from '@/composables/symbols/useTableColumnPreferences'
import type { IndexLatestRow } from './types'
import type { SwLevel } from './useASharesIndexQuery'

const emit = defineEmits<{
  (e: 'jump-to-members', payload: { tsCode: string; name: string; category: string }): void
}>()

const message = useMessage()
const {
  loading,
  rows,
  searchQuery,
  selectedType,
  swLevel,
  paginationState,
  reload,
  applyLevelFilter,
  applySearch,
  handlePageChange,
  handlePageSizeChange,
  handleSort,
} = useASharesIndexQuery(message)

// 申万区固定 type='sw'，层级默认一级。
selectedType.value = 'sw'
swLevel.value = 1

const activeLevel = computed(() => swLevel.value ?? 1)

function onLevelChange(value: number | string | boolean | null) {
  swLevel.value = Number(value) as SwLevel
  applyLevelFilter()
}

const columnDefs = computed(() =>
  createASharesIndexColumnDefs({
    showValuation: true,
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
} = useTableColumnPreferences('aSharesIndexSw', columnDefs, 'table')

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

const RELOAD_THROTTLE_MS = 60_000
const lastLoadedAt = ref(0)

/** 首屏 / 节流放行后的 onActivated 重查；用户筛选/分页/排序/刷新按钮不走此路径。 */
async function reloadAndMarkLoaded() {
  await reload()
  lastLoadedAt.value = Date.now()
}

// 生命周期同 ThsPanel：首屏 onMounted，切回 onActivated 节流刷新（keep-alive）。
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
.a-shares-index-sw-panel {
  height: 100%;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
}

.level-radio {
  flex-shrink: 0;
}

.search-input {
  max-width: 260px;
}
</style>
