<template>
  <div class="a-shares-index-etf-panel">
    <n-card :bordered="false">
      <div class="toolbar">
        <n-radio-group
          :value="fundType ?? 'all'"
          class="fund-type-radio"
          @update:value="onFundTypeChange"
        >
          <n-radio-button value="all">全部</n-radio-button>
          <n-radio-button
            v-for="t in fundTypeOptions"
            :key="t"
            :value="t"
          >
            {{ t }}
          </n-radio-button>
        </n-radio-group>
        <n-select
          v-model:value="managerValue"
          :options="managerOptions"
          placeholder="管理人"
          clearable
          class="manager-select"
          @update:value="applyManagerFilter"
        />
        <n-select
          v-model:value="iopvValue"
          :options="iopvOptions"
          placeholder="公布IOPV"
          clearable
          class="iopv-select"
          @update:value="applyIopvFilter"
        />
        <n-input
          v-model:value="searchQuery"
          placeholder="搜索ETF名称"
          clearable
          class="search-input"
          @keyup.enter="applySearch"
        />
        <n-button :loading="loading" @click="reload">刷新</n-button>
        <n-button @click="showColumnSettings = true">列设置</n-button>
      </div>

      <n-data-table
        data-testid="a-shares-index-etf-table"
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
      title="ETF 列设置"
      :definitions="columnDefs"
      :loading="columnPrefsLoading"
      :saving="columnPrefsSaving"
      @save="handleSaveColumnPreferences"
    />

    <etf-kline-modal
      v-model:show="showEtfModal"
      :row="selectedRow"
      @jump-to-members="handleJumpToMembers"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'ASharesIndexEtfPanel' })

import { computed, onActivated, onMounted, ref } from 'vue'
import {
  NButton,
  NCard,
  NDataTable,
  NInput,
  NRadioButton,
  NRadioGroup,
  NSelect,
  useMessage,
} from 'naive-ui'
import type { SelectOption } from 'naive-ui'
import ColumnSettingsDrawer from '../columns/ColumnSettingsDrawer.vue'
import EtfKlineModal from './EtfKlineModal.vue'
import { createEtfColumnDefs } from './etfColumns'
import { useEtfQuery } from './useEtfQuery'
import { etfApi } from '@/api/modules/market/etf'
import { useTableColumnPreferences } from '@/composables/symbols/useTableColumnPreferences'
import type { EtfLatestRow } from './etf.types'

const emit = defineEmits<{
  (e: 'jump-to-members', payload: { tsCode: string; name: string; category: string; memberTsCodes?: string[] }): void
}>()

const message = useMessage()
const {
  loading,
  rows,
  searchQuery,
  fundType,
  manager,
  publishIopv,
  paginationState,
  reload,
  applyFundTypeFilter,
  applyManagerFilter,
  applyIopvFilter,
  applySearch,
  handlePageChange,
  handlePageSizeChange,
  handleSort,
} = useEtfQuery(message)

// 基金类型选项：distinct fund_type 动态拉取（R4 方案 C，保证 radio 每项都有匹配数据）
const fundTypeOptions = ref<string[]>([])
async function loadFundTypes() {
  try {
    fundTypeOptions.value = await etfApi.getFundTypes()
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

// 基金类型 radio-group 本地值（'all' 不发后端）
function onFundTypeChange(value: string | number | boolean | null) {
  fundType.value = value === 'all' ? undefined : String(value)
  applyFundTypeFilter()
}

// 管理人 select（文本输入 + 下拉，暂用简单 select；后续可换 n-auto-complete）
const managerValue = ref<string | null>(null)
function onManagerChange(value: string) {
  manager.value = value || undefined
}
const managerOptions: SelectOption[] = []

// IOPV select
const iopvValue = ref<string | null>(null)
const iopvOptions: SelectOption[] = [
  { label: '是', value: 'true' },
  { label: '否', value: 'false' },
]

const columnDefs = computed(() =>
  createEtfColumnDefs(),
)
const showColumnSettings = ref(false)

const {
  loading: columnPrefsLoading,
  saving: columnPrefsSaving,
  scopePreferences,
  tableColumns,
  load: loadColumnPreferences,
  save: saveColumnPreferences,
} = useTableColumnPreferences('aSharesIndexEtf', columnDefs, 'table')

async function handleSaveColumnPreferences() {
  try {
    await saveColumnPreferences()
    showColumnSettings.value = false
    message.success('列设置已保存')
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  }
}

const showEtfModal = ref(false)
const selectedRow = ref<EtfLatestRow | null>(null)

function rowProps(row: EtfLatestRow) {
  return {
    style: 'cursor: pointer;',
    onClick: () => {
      selectedRow.value = row
      showEtfModal.value = true
    },
  }
}

/** 成分股跳转：从 PCF tab 事件转发到父级（ASharesIndexPanel → ASharesTabsContainer → 股票面板） */
function handleJumpToMembers(payload: { tsCodes: string[]; name: string }) {
  const firstTsCode = payload.tsCodes[0] ?? ''
  emit('jump-to-members', {
    tsCode: firstTsCode,
    name: payload.name,
    category: 'etf',
    memberTsCodes: payload.tsCodes,
  })
}

const RELOAD_THROTTLE_MS = 60_000
const lastLoadedAt = ref(0)

async function reloadAndMarkLoaded() {
  await reload()
  lastLoadedAt.value = Date.now()
}

onMounted(() => {
  void reloadAndMarkLoaded()
  void loadFundTypes()
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
.a-shares-index-etf-panel {
  height: 100%;
}

.toolbar {
  display: flex;
  align-items: center;
  gap: 12px;
  margin-bottom: 16px;
  flex-wrap: wrap;
}

.fund-type-radio {
  flex-shrink: 0;
}

.manager-select {
  width: 140px;
}

.iopv-select {
  width: 120px;
}

.search-input {
  max-width: 260px;
}
</style>
