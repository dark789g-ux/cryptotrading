<template>
  <div class="step-members">
    <div class="toolbar">
      <n-auto-complete
        v-model:value="searchText"
        :options="searchOptions"
        :loading="searchLoading"
        placeholder="搜索股票名称或代码"
        clearable
        class="search-input"
        @select="onSelectSearch"
        @update:value="onSearchInput"
      />
      <n-select
        v-model:value="selectedIndexCode"
        :options="indexOptions"
        :loading="indexOptionsLoading"
        filterable
        clearable
        placeholder="从指数导入"
        class="import-select"
        @update:value="onImportFromIndex"
      />
      <n-select
        v-model:value="selectedWatchlistId"
        :options="watchlistOptions"
        :loading="watchlistsLoading"
        clearable
        placeholder="从自选导入"
        class="import-select"
        @update:value="onImportFromWatchlist"
      />
    </div>

    <div class="member-header">
      已选成分 ({{ members.length }})，须 {{ minMembers }}–{{ maxMembers }} 只
    </div>

    <n-data-table
      size="small"
      :columns="columns"
      :data="members"
      :max-height="280"
      :pagination="false"
    />
  </div>
</template>

<script setup lang="ts">
defineOptions({ name: 'StepMembers' })

import { computed, h, onMounted, ref } from 'vue'
import type { DataTableColumns } from 'naive-ui'
import { NAutoComplete, NButton, NDataTable, NSelect, useMessage } from 'naive-ui'
import { aSharesApi } from '@/api/modules/market/aShares'
import { customIndexApi } from '@/api/modules/market/customIndex'
import { indexDailyApi } from '@/api/modules/market/indexDaily'
import { watchlistApi } from '@/api'
import type { WizardMember } from './useCreateCustomIndexWizard'

const props = defineProps<{
  members: WizardMember[]
  minMembers: number
  maxMembers: number
}>()

const emit = defineEmits<{
  add: [member: WizardMember]
  remove: [conCode: string]
  'import-members': [items: Array<{ conCode: string; name: string }>]
}>()

const message = useMessage()
const searchText = ref('')
const searchLoading = ref(false)
const searchOptions = ref<Array<{ label: string; value: string }>>([])

const selectedIndexCode = ref<string | null>(null)
const indexOptions = ref<Array<{ label: string; value: string }>>([])
const indexOptionsLoading = ref(false)

const selectedWatchlistId = ref<string | null>(null)
const watchlistOptions = ref<Array<{ label: string; value: string }>>([])
const watchlistsLoading = ref(false)

const columns = computed<DataTableColumns<WizardMember>>(() => [
  { title: '代码', key: 'conCode', width: 120 },
  { title: '名称', key: 'name', ellipsis: { tooltip: true } },
  {
    title: '操作',
    key: 'action',
    width: 80,
    render: (row) =>
      h(
        NButton,
        { size: 'small', type: 'error', quaternary: true, onClick: () => emit('remove', row.conCode) },
        { default: () => '移除' },
      ),
  },
])

let searchTimer: ReturnType<typeof setTimeout> | null = null

function onSearchInput(value: string) {
  searchText.value = value
  if (searchTimer) clearTimeout(searchTimer)
  if (!value.trim()) {
    searchOptions.value = []
    return
  }
  searchTimer = setTimeout(() => void runSearch(value.trim()), 300)
}

async function runSearch(q: string) {
  searchLoading.value = true
  try {
    const res = await aSharesApi.query({ page: 1, pageSize: 20, q })
    searchOptions.value = res.rows.map((r) => ({
      label: `${r.name} (${r.tsCode})`,
      value: r.tsCode,
    }))
  } catch {
    searchOptions.value = []
  } finally {
    searchLoading.value = false
  }
}

function onSelectSearch(value: string) {
  const opt = searchOptions.value.find((o) => o.value === value)
  if (!opt) return
  const nameMatch = opt.label.match(/^(.+?)\s+\(/)
  const name = nameMatch?.[1] ?? value
  if (tryAdd({ conCode: value, name })) {
    searchText.value = ''
    searchOptions.value = []
  }
}

function tryAdd(member: WizardMember): boolean {
  if (props.members.some((m) => m.conCode === member.conCode)) {
    message.warning('该标的已在列表中')
    return false
  }
  if (props.members.length >= props.maxMembers) {
    message.warning(`最多 ${props.maxMembers} 只成分股`)
    return false
  }
  emit('add', member)
  return true
}

async function loadIndexOptions() {
  indexOptionsLoading.value = true
  try {
    const [ths, sw] = await Promise.all([
      indexDailyApi.getCatalog({ category: 'industry' }),
      indexDailyApi.getCatalog({ category: 'sw' }),
    ])
    indexOptions.value = [...ths, ...sw].map((r) => ({
      label: `${r.name} (${r.tsCode})`,
      value: r.tsCode,
    }))
  } catch {
    indexOptions.value = []
  } finally {
    indexOptionsLoading.value = false
  }
}

async function onImportFromIndex(tsCode: string | null) {
  if (!tsCode) return
  selectedIndexCode.value = null
  try {
    const res = await customIndexApi.getIndexCatalogMembers(tsCode)
    emit('import-members', res.members.map((m) => ({ conCode: m.conCode, name: m.name })))
    message.success(`已导入 ${res.members.length} 只成分股`)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '导入失败')
  }
}

async function loadWatchlists() {
  watchlistsLoading.value = true
  try {
    const lists = await watchlistApi.list()
    watchlistOptions.value = lists.map((w) => ({ label: w.name, value: w.id }))
  } catch {
    watchlistOptions.value = []
  } finally {
    watchlistsLoading.value = false
  }
}

async function onImportFromWatchlist(watchlistId: string | null) {
  if (!watchlistId) return
  selectedWatchlistId.value = null
  try {
    const wl = await watchlistApi.get(watchlistId)
    const items = (wl.items ?? []).map((i) => ({ conCode: i.symbol, name: i.symbol }))
    emit('import-members', items)
    message.success(`已导入 ${items.length} 只自选成分`)
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : '导入失败')
  }
}

onMounted(() => {
  void loadIndexOptions()
  void loadWatchlists()
})
</script>

<style scoped>
.toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 10px;
  margin-bottom: 12px;
}
.search-input {
  flex: 1;
  min-width: 200px;
}
.import-select {
  width: 180px;
}
.member-header {
  font-size: 13px;
  color: var(--color-text-secondary);
  margin-bottom: 8px;
}
</style>
