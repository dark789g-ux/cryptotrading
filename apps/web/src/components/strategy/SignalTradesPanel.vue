<template>
  <div class="signal-trades-panel">
    <!-- Filter bar -->
    <div class="filter-bar">
      <n-input
        v-model:value="fTsCode"
        placeholder="代码搜索"
        clearable
        size="small"
        style="width: 120px"
        @input="onTsCodeInput"
        @clear="applyFilters"
      />
      <n-select
        v-model:value="fExitReason"
        :options="exitReasonOptions"
        clearable
        placeholder="出场原因"
        size="small"
        style="width: 120px"
        @update:value="applyFilters"
      />
      <span class="filter-label">收益%</span>
      <n-input-number
        v-model:value="fRetMinPct"
        :show-button="false"
        placeholder="≥"
        clearable
        size="small"
        style="width: 80px"
        @update:value="applyFilters"
      />
      <span class="filter-sep">~</span>
      <n-input-number
        v-model:value="fRetMaxPct"
        :show-button="false"
        placeholder="≤"
        clearable
        size="small"
        style="width: 80px"
        @update:value="applyFilters"
      />
      <span class="filter-label">持仓天</span>
      <n-input-number
        v-model:value="fHoldMin"
        :show-button="false"
        placeholder="≥"
        clearable
        size="small"
        style="width: 72px"
        @update:value="applyFilters"
      />
      <span class="filter-sep">~</span>
      <n-input-number
        v-model:value="fHoldMax"
        :show-button="false"
        placeholder="≤"
        clearable
        size="small"
        style="width: 72px"
        @update:value="applyFilters"
      />
      <n-button size="small" @click="resetFilters">重置</n-button>
    </div>

    <!-- Remote table -->
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
      @update:sorter="onSort"
    />

    <!-- K-line detail modal -->
    <SignalTradeKlineModal
      v-model:show="showDetail"
      :trade="detailRow"
    />
  </div>
</template>

<script setup lang="ts">
import { computed, onMounted, ref } from 'vue'
import {
  NButton,
  NDataTable,
  NInput,
  NInputNumber,
  NSelect,
} from 'naive-ui'
import type { DataTableSortState } from 'naive-ui'
import { useSignalStatsStore } from '../../stores/signalStats'
import type { ListTradesParams, SignalTestTrade } from '../../api/modules/strategy/signalStats'
import { buildTradeColumns } from './signalTradeColumns'
import SignalTradeKlineModal from './SignalTradeKlineModal.vue'

defineOptions({ name: 'SignalTradesPanel' })

const props = defineProps<{ runId: string }>()
const store = useSignalStatsStore()

// ── Filter state ────────────────────────────────────────────────────────────

const fTsCode = ref('')
const fExitReason = ref<SignalTestTrade['exitReason'] | null>(null)
const fRetMinPct = ref<number | null>(null)
const fRetMaxPct = ref<number | null>(null)
const fHoldMin = ref<number | null>(null)
const fHoldMax = ref<number | null>(null)

const exitReasonOptions = [
  { label: '强平', value: 'max_hold' },
  { label: '信号', value: 'signal' },
  { label: '退市', value: 'delist' },
  { label: '止损', value: 'stop' },
  { label: 'MA5离场', value: 'ma5_exit' },
]

// ── Sort / pagination ───────────────────────────────────────────────────────

const sortField = ref<ListTradesParams['sortField']>(undefined)
const sortOrder = ref<'asc' | 'desc' | undefined>(undefined)
const page = ref(1)
const pageSize = ref(50)

// ── Display state ───────────────────────────────────────────────────────────

const rows = ref<SignalTestTrade[]>([])
const total = ref(0)
const loading = ref(false)

// ── Detail modal ────────────────────────────────────────────────────────────

const detailRow = ref<SignalTestTrade | null>(null)
const showDetail = ref(false)

// ── Columns ─────────────────────────────────────────────────────────────────

const columns = buildTradeColumns({
  onViewDetail: (row) => {
    detailRow.value = row
    showDetail.value = true
  },
})

// ── Pagination ───────────────────────────────────────────────────────────────

const pagination = computed(() => ({
  page: page.value,
  pageSize: pageSize.value,
  itemCount: total.value,
  showSizePicker: true,
  pageSizes: [20, 50, 100],
  prefix: () => `共 ${total.value} 条`,
}))

// ── Data loading ─────────────────────────────────────────────────────────────

function buildParams(): ListTradesParams {
  return {
    page: page.value,
    pageSize: pageSize.value,
    sortField: sortField.value,
    sortOrder: sortOrder.value,
    tsCode: fTsCode.value.trim() || undefined,
    exitReason: fExitReason.value ?? undefined,
    retMin: fRetMinPct.value != null ? fRetMinPct.value / 100 : undefined,
    retMax: fRetMaxPct.value != null ? fRetMaxPct.value / 100 : undefined,
    holdDaysMin: fHoldMin.value ?? undefined,
    holdDaysMax: fHoldMax.value ?? undefined,
  }
}

let reqSeq = 0
async function load() {
  const my = ++reqSeq
  loading.value = true
  try {
    const data = await store.fetchTrades(props.runId, buildParams())
    if (my !== reqSeq) return
    rows.value = data.items
    total.value = data.total
  } finally {
    if (my === reqSeq) loading.value = false
  }
}

// ── Event handlers ────────────────────────────────────────────────────────────

function applyFilters() {
  page.value = 1
  void load()
}

function resetFilters() {
  fTsCode.value = ''
  fExitReason.value = null
  fRetMinPct.value = null
  fRetMaxPct.value = null
  fHoldMin.value = null
  fHoldMax.value = null
  page.value = 1
  void load()
}

// Debounce for tsCode input (~300ms)
let tsCodeTimer: ReturnType<typeof setTimeout> | null = null
function onTsCodeInput() {
  if (tsCodeTimer !== null) clearTimeout(tsCodeTimer)
  tsCodeTimer = setTimeout(() => {
    tsCodeTimer = null
    applyFilters()
  }, 300)
}

const SORT_ALLOWED = [
  'tsCode', 'signalDate', 'buyDate', 'exitDate',
  'buyPrice', 'exitPrice', 'ret', 'holdDays', 'exitReason',
]

function onSort(s: DataTableSortState | DataTableSortState[] | null) {
  const st = Array.isArray(s) ? s[0] : s
  const key = st && typeof st.columnKey === 'string' ? st.columnKey : undefined
  const ord =
    st?.order === 'ascend' ? 'asc' :
    st?.order === 'descend' ? 'desc' :
    undefined
  sortField.value = (ord && key && SORT_ALLOWED.includes(key))
    ? (key as ListTradesParams['sortField'])
    : undefined
  sortOrder.value = ord
  page.value = 1
  void load()
}

function onPage(p: number) {
  page.value = p
  void load()
}

function onPageSize(s: number) {
  pageSize.value = s
  page.value = 1
  void load()
}

// ── Lifecycle ─────────────────────────────────────────────────────────────────

onMounted(load)
</script>

<style scoped>
.signal-trades-panel {
  padding-top: 8px;
}

.filter-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 6px;
  margin-bottom: 10px;
}

.filter-label {
  font-size: 13px;
  color: var(--n-text-color-2, #666);
  white-space: nowrap;
}

.filter-sep {
  font-size: 13px;
  color: var(--n-text-color-3, #bbb);
}
</style>
