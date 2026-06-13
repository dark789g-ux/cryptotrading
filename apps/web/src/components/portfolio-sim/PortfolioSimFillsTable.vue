<template>
  <div class="fills">
    <!-- 筛选条 -->
    <div class="fills__filters">
      <n-select
        v-model:value="filters.status"
        :options="statusOptions"
        placeholder="状态"
        clearable
        size="small"
        style="width: 130px"
        @update:value="onFilterChange"
      />
      <n-select
        v-model:value="filters.skipReason"
        :options="skipReasonOptions"
        placeholder="弃单原因"
        clearable
        size="small"
        style="width: 170px"
        @update:value="onFilterChange"
      />
      <n-input
        v-model:value="filters.sourceLabel"
        placeholder="源标签精确匹配"
        clearable
        size="small"
        style="width: 170px"
        @keydown.enter="onFilterChange"
        @clear="onFilterChange"
      />
      <n-input
        v-model:value="filters.buyDateStart"
        placeholder="买入日起 YYYYMMDD"
        clearable
        size="small"
        style="width: 160px"
        @keydown.enter="onFilterChange"
        @clear="onFilterChange"
      />
      <n-input
        v-model:value="filters.buyDateEnd"
        placeholder="买入日止 YYYYMMDD"
        clearable
        size="small"
        style="width: 160px"
        @keydown.enter="onFilterChange"
        @clear="onFilterChange"
      />
      <n-button size="small" @click="onFilterChange">应用筛选</n-button>
    </div>

    <n-data-table
      remote
      :columns="columns"
      :data="rows"
      :loading="loading"
      :pagination="pagination"
      :bordered="false"
      size="small"
      @update:page="onPage"
      @update:page-size="onPageSize"
      @update:sorter="onSorter"
    />
  </div>
</template>

<script setup lang="ts">
import { h, reactive, ref, onMounted } from 'vue'
import { NButton, NDataTable, NInput, NSelect, NTag } from 'naive-ui'
import type { DataTableColumns, DataTableSortState, SelectOption } from 'naive-ui'
import { portfolioSimApi } from '../../api/modules/strategy/portfolioSim'
import type {
  PortfolioSimFill,
  FillSortField,
  ListFillsParams,
  PortfolioSimFillStatus,
  PortfolioSkipReason,
} from '../../api/modules/strategy/portfolioSim'
import { SKIP_REASON_LABELS } from './portfolioSimPresets'
import { formatTradeDate } from '../symbols/a-shares/aSharesFormatters'

const props = defineProps<{ runId: string }>()

const rows = ref<PortfolioSimFill[]>([])
const loading = ref(false)

const filters = reactive<{
  status: PortfolioSimFillStatus | null
  skipReason: PortfolioSkipReason | null
  sourceLabel: string
  buyDateStart: string
  buyDateEnd: string
}>({
  status: null,
  skipReason: null,
  sourceLabel: '',
  buyDateStart: '',
  buyDateEnd: '',
})

const sortState = ref<{ field: FillSortField; order: 'asc' | 'desc' } | null>(null)

// 受控分页：remote 模式下 page/pageSize 必须受控（itemCount 来自服务端 total）
const pagination = reactive({
  page: 1,
  pageSize: 50,
  itemCount: 0,
  showSizePicker: true,
  pageSizes: [20, 50, 100, 200],
})

const statusOptions: SelectOption[] = [
  { label: '成交 taken', value: 'taken' },
  { label: '弃单 skipped', value: 'skipped' },
]

const skipReasonOptions: SelectOption[] = (
  Object.keys(SKIP_REASON_LABELS) as PortfolioSkipReason[]
).map((k) => ({ label: SKIP_REASON_LABELS[k], value: k }))

function num(v: string | null, digits = 4): string {
  if (v == null) return '—'
  const n = parseFloat(v)
  return Number.isFinite(n) ? n.toFixed(digits) : '—'
}

const columns: DataTableColumns<PortfolioSimFill> = [
  {
    title: '状态',
    key: 'status',
    width: 90,
    sorter: true,
    render(row) {
      return row.status === 'taken'
        ? h(NTag, { type: 'success', size: 'small' }, { default: () => '成交' })
        : h(NTag, { type: 'warning', size: 'small' }, { default: () => '弃单' })
    },
  },
  { title: '源', key: 'sourceLabel', width: 120, sorter: true, ellipsis: { lineClamp: 3, tooltip: true } },
  { title: 'ts_code', key: 'tsCode', width: 110, sorter: true },
  {
    title: '信号日',
    key: 'signalDate',
    width: 110,
    sorter: true,
    render: (r) => formatTradeDate(r.signalDate),
  },
  {
    title: '买入日',
    key: 'buyDate',
    width: 110,
    sorter: true,
    render: (r) => formatTradeDate(r.buyDate),
  },
  {
    title: '出场日',
    key: 'exitDate',
    width: 110,
    sorter: true,
    render: (r) => (r.exitDate ? formatTradeDate(r.exitDate) : '—'),
  },
  {
    title: 'rank值',
    key: 'rankValue',
    width: 110,
    align: 'right',
    sorter: true,
    render: (r) => num(r.rankValue, 2),
  },
  {
    title: '权重',
    key: 'weightEntry',
    width: 100,
    align: 'right',
    sorter: true,
    render: (r) => {
      if (r.weightEntry == null) return '—'
      const n = parseFloat(r.weightEntry)
      return Number.isFinite(n) ? `${(n * 100).toFixed(2)}%` : '—'
    },
  },
  {
    title: '税后收益',
    key: 'realizedRetNet',
    width: 110,
    align: 'right',
    sorter: true,
    render: (r) => {
      if (r.realizedRetNet == null) return '—'
      const n = parseFloat(r.realizedRetNet)
      if (!Number.isFinite(n)) return '—'
      const cls = n > 0 ? 'pos' : n < 0 ? 'neg' : ''
      return h('span', { class: cls }, `${(n * 100).toFixed(2)}%`)
    },
  },
  {
    title: '弃单原因',
    key: 'skipReason',
    width: 130,
    ellipsis: { lineClamp: 3, tooltip: true },
    render: (r) => (r.skipReason ? SKIP_REASON_LABELS[r.skipReason] ?? r.skipReason : '—'),
  },
]

function currentParams(): ListFillsParams {
  return {
    page: pagination.page,
    pageSize: pagination.pageSize,
    sortField: sortState.value?.field,
    sortOrder: sortState.value?.order,
    status: filters.status ?? undefined,
    skipReason: filters.skipReason ?? undefined,
    sourceLabel: filters.sourceLabel.trim() || undefined,
    buyDateStart: filters.buyDateStart.trim() || undefined,
    buyDateEnd: filters.buyDateEnd.trim() || undefined,
  }
}

async function fetchPage() {
  loading.value = true
  try {
    const page = await portfolioSimApi.listFills(props.runId, currentParams())
    rows.value = page.items
    pagination.itemCount = page.total
  } finally {
    loading.value = false
  }
}

function onPage(p: number) {
  pagination.page = p
  void fetchPage()
}

function onPageSize(ps: number) {
  pagination.pageSize = ps
  pagination.page = 1
  void fetchPage()
}

function onSorter(state: DataTableSortState | null) {
  if (!state || !state.order) {
    sortState.value = null
  } else {
    sortState.value = {
      field: state.columnKey as FillSortField,
      order: state.order === 'descend' ? 'desc' : 'asc',
    }
  }
  pagination.page = 1
  void fetchPage()
}

function onFilterChange() {
  pagination.page = 1
  void fetchPage()
}

onMounted(fetchPage)
</script>

<style scoped>
.fills {
  display: flex;
  flex-direction: column;
  gap: 12px;
}

.fills__filters {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  align-items: center;
}

:deep(.pos) {
  color: #d03050;
}

:deep(.neg) {
  color: #18a058;
}
</style>
