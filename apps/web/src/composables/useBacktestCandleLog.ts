import { ref, computed, watch, h, type Ref } from 'vue'
import { useMessage, NTooltip, type DataTableSortState } from 'naive-ui'
import { backtestApi, type CandleLogRow, type BacktestCandleLogFilters } from './useApi'

type CandleLogFilterState = BacktestCandleLogFilters
type CandleLogSortBy = 'bar_idx' | 'ts' | 'open_equity' | 'close_equity' | 'pos_count'

interface StoredState {
  filtersDraft: CandleLogFilterState
  filtersApplied: CandleLogFilterState
  page: number
  pageSize: number
  sortBy: CandleLogSortBy
  sortOrder: 'asc' | 'desc'
}

const DEFAULT_SORT_BY = 'bar_idx'
const DEFAULT_SORT_ORDER: 'asc' | 'desc' = 'desc'

function createEmptyFilters(): CandleLogFilterState {
  return {
    onlyWithAction: false,
    symbol: '',
    inCooldown: null,
    startTs: null,
    endTs: null,
  }
}

function cloneFilters(filters: CandleLogFilterState): CandleLogFilterState {
  return {
    onlyWithAction: Boolean(filters.onlyWithAction),
    symbol: filters.symbol ?? '',
    inCooldown: typeof filters.inCooldown === 'boolean' ? filters.inCooldown : null,
    startTs: filters.startTs ?? null,
    endTs: filters.endTs ?? null,
  }
}

export function useBacktestCandleLog(
  selectedRunId: Ref<string | null>,
  activeTab: Ref<string>,
) {
  const message = useMessage()

  const candleLogRows = ref<CandleLogRow[]>([])
  const candleLogTotal = ref(0)
  const candleLogLoading = ref(false)
  const filtersDraft = ref<CandleLogFilterState>(createEmptyFilters())
  const filtersApplied = ref<CandleLogFilterState>(createEmptyFilters())
  const candleLogPage = ref(1)
  const candleLogPageSize = ref(50)
  const candleLogSortBy = ref<CandleLogSortBy>(DEFAULT_SORT_BY)
  const candleLogSortOrder = ref<'asc' | 'desc'>(DEFAULT_SORT_ORDER)
  const stateByRunId = new Map<string, StoredState>()

  const candleLogPagination = computed(() => ({
    page: candleLogPage.value,
    pageSize: candleLogPageSize.value,
    itemCount: candleLogTotal.value,
    pageSizes: [20, 50, 100, 200],
    showSizePicker: true,
  }))

  const hasAppliedFilters = computed(() =>
    Boolean(
      filtersApplied.value.onlyWithAction ||
      filtersApplied.value.symbol ||
      filtersApplied.value.startTs ||
      filtersApplied.value.endTs ||
      typeof filtersApplied.value.inCooldown === 'boolean',
    ),
  )
  const emptyText = computed(() => (
    hasAppliedFilters.value ? '当前筛选条件下无数据' : '该历史回测未记录K线日志'
  ))

  const buildEntriesTooltip = (row: CandleLogRow) =>
    h('div', row.entries.map((e) =>
      h('div', `${e.symbol} @ ${e.price} × ${e.shares} (${e.reason})`),
    ))

  const buildExitsTooltip = (row: CandleLogRow) =>
    h('div', row.exits.map((e) =>
      h('div', `${e.symbol} pnl=${e.pnl.toFixed(2)} (${e.reason}${e.isHalf ? ' 分批' : ''})`),
    ))

  const candleLogColumns = computed(() => [
    {
      title: '序号',
      key: 'barIdx',
      width: 80,
      sortOrder: candleLogSortBy.value === 'bar_idx' ? (candleLogSortOrder.value === 'desc' ? 'descend' : 'ascend') : false,
      sorter: true,
      render: (_row: CandleLogRow, rowIndex: number) =>
        candleLogTotal.value - (candleLogPage.value - 1) * candleLogPageSize.value - rowIndex,
    },
    {
      title: '时间',
      key: 'ts',
      width: 160,
      sortOrder: candleLogSortBy.value === 'ts' ? (candleLogSortOrder.value === 'desc' ? 'descend' : 'ascend') : false,
      sorter: true,
      render: (row: CandleLogRow) => row.ts,
    },
    {
      title: '开盘净值',
      key: 'openEquity',
      width: 100,
      sortOrder: candleLogSortBy.value === 'open_equity' ? (candleLogSortOrder.value === 'desc' ? 'descend' : 'ascend') : false,
      sorter: true,
      render: (row: CandleLogRow) => row.openEquity.toFixed(2),
    },
    {
      title: '收盘净值',
      key: 'closeEquity',
      width: 100,
      sortOrder: candleLogSortBy.value === 'close_equity' ? (candleLogSortOrder.value === 'desc' ? 'descend' : 'ascend') : false,
      sorter: true,
      render: (row: CandleLogRow) => row.closeEquity.toFixed(2),
    },
    {
      title: '持仓数',
      key: 'posCount',
      width: 80,
      sortOrder: candleLogSortBy.value === 'pos_count' ? (candleLogSortOrder.value === 'desc' ? 'descend' : 'ascend') : false,
      sorter: true,
      render: (row: CandleLogRow) => `${row.posCount}/${row.maxPositions}`,
    },
    {
      title: '入场',
      key: 'entries',
      width: 90,
      render: (row: CandleLogRow) => {
        if (row.entries.length === 0) return '—'
        return h(NTooltip, { placement: 'top' }, {
          trigger: () => h('span', { style: 'cursor:pointer;text-decoration:underline dotted' }, `${row.entries.length} 条`),
          default: () => buildEntriesTooltip(row),
        })
      },
    },
    {
      title: '出场',
      key: 'exits',
      width: 90,
      render: (row: CandleLogRow) => {
        if (row.exits.length === 0) return '—'
        return h(NTooltip, { placement: 'top' }, {
          trigger: () => h('span', { style: 'cursor:pointer;text-decoration:underline dotted' }, `${row.exits.length} 条`),
          default: () => buildExitsTooltip(row),
        })
      },
    },
    {
      title: '冷却中',
      key: 'inCooldown',
      width: 80,
      render: (row: CandleLogRow) => (row.inCooldown ? '是' : '否'),
    },
  ])

  const saveState = (runId: string) => {
    stateByRunId.set(runId, {
      filtersDraft: cloneFilters(filtersDraft.value),
      filtersApplied: cloneFilters(filtersApplied.value),
      page: candleLogPage.value,
      pageSize: candleLogPageSize.value,
      sortBy: candleLogSortBy.value,
      sortOrder: candleLogSortOrder.value,
    })
  }

  const restoreState = (runId: string) => {
    const cached = stateByRunId.get(runId)
    if (!cached) {
      filtersDraft.value = createEmptyFilters()
      filtersApplied.value = createEmptyFilters()
      candleLogPage.value = 1
      candleLogPageSize.value = 50
      candleLogSortBy.value = DEFAULT_SORT_BY
      candleLogSortOrder.value = DEFAULT_SORT_ORDER
      return
    }
    filtersDraft.value = cloneFilters(cached.filtersDraft)
    filtersApplied.value = cloneFilters(cached.filtersApplied)
    candleLogPage.value = cached.page
    candleLogPageSize.value = cached.pageSize
    candleLogSortBy.value = cached.sortBy
    candleLogSortOrder.value = cached.sortOrder
  }

  const validateFilters = () => {
    if (filtersDraft.value.startTs && filtersDraft.value.endTs && filtersDraft.value.startTs > filtersDraft.value.endTs) {
      message.error('开始时间不能晚于结束时间')
      return false
    }
    return true
  }

  const loadCandleLog = async () => {
    if (!selectedRunId.value) return
    candleLogLoading.value = true
    try {
      const res = await backtestApi.getCandleLog(selectedRunId.value, {
        page: candleLogPage.value,
        pageSize: candleLogPageSize.value,
        ...filtersApplied.value,
        sortBy: candleLogSortBy.value,
        sortOrder: candleLogSortOrder.value,
      })
      candleLogRows.value = res.rows
      candleLogTotal.value = res.total
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      candleLogLoading.value = false
    }
  }

  const applyFilters = () => {
    if (!validateFilters()) return
    filtersApplied.value = cloneFilters(filtersDraft.value)
    candleLogPage.value = 1
    if (selectedRunId.value) saveState(selectedRunId.value)
    loadCandleLog()
  }

  const resetFilters = () => {
    filtersDraft.value = createEmptyFilters()
    filtersApplied.value = createEmptyFilters()
    candleLogPage.value = 1
    candleLogSortBy.value = DEFAULT_SORT_BY
    candleLogSortOrder.value = DEFAULT_SORT_ORDER
    if (selectedRunId.value) saveState(selectedRunId.value)
    loadCandleLog()
  }

  const onCandleLogPage = (page: number) => {
    candleLogPage.value = page
    if (selectedRunId.value) saveState(selectedRunId.value)
    loadCandleLog()
  }

  const onCandleLogPageSize = (pageSize: number) => {
    candleLogPageSize.value = pageSize
    candleLogPage.value = 1
    if (selectedRunId.value) saveState(selectedRunId.value)
    loadCandleLog()
  }

  const keyToSortBy: Record<string, typeof candleLogSortBy.value> = {
    barIdx: 'bar_idx',
    ts: 'ts',
    openEquity: 'open_equity',
    closeEquity: 'close_equity',
    posCount: 'pos_count',
  }

  const onCandleLogSort = (sorterState: DataTableSortState | null) => {
    if (!sorterState || !sorterState.order) {
      // 取消排序时回退默认值
      candleLogSortBy.value = 'bar_idx'
      candleLogSortOrder.value = 'desc'
    } else {
      candleLogSortBy.value = keyToSortBy[sorterState.columnKey as string] ?? 'bar_idx'
      candleLogSortOrder.value = sorterState.order === 'ascend' ? 'asc' : 'desc'
    }
    candleLogPage.value = 1
    if (selectedRunId.value) saveState(selectedRunId.value)
    loadCandleLog()
  }

  watch(filtersDraft, () => {
    if (selectedRunId.value && activeTab.value === 'candleLog') saveState(selectedRunId.value)
  }, { deep: true })

  watch([selectedRunId, activeTab], ([id, tab], [prevId, prevTab]) => {
    if (prevId && prevTab === 'candleLog') saveState(prevId)
    if (id && tab === 'candleLog') {
      restoreState(id)
      loadCandleLog()
    }
  }, { immediate: true })

  return {
    candleLogRows,
    candleLogTotal,
    candleLogLoading,
    filtersDraft,
    filtersApplied,
    hasAppliedFilters,
    emptyText,
    candleLogPagination,
    candleLogColumns,
    loadCandleLog,
    applyFilters,
    resetFilters,
    onCandleLogPage,
    onCandleLogPageSize,
    onCandleLogSort,
  }
}
