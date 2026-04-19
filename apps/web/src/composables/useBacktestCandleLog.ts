import { ref, computed, watch, h, type Ref } from 'vue'
import { useMessage, NTooltip, NButton, type DataTableSortState } from 'naive-ui'
import { backtestApi, type CandleLogRow, type BacktestCandleLogFilters } from './useApi'

type CandleLogFilterState = BacktestCandleLogFilters
type CandleLogSortBy = 'bar_idx' | 'ts' | 'open_equity' | 'close_equity' | 'pos_count' | 'equity_change' | 'equity_change_pct'

interface StoredState {
  filtersDraft: CandleLogFilterState
  filtersApplied: CandleLogFilterState
  page: number
  pageSize: number
  sortBy: CandleLogSortBy
  sortOrder: 'asc' | 'desc'
  explicitSort: boolean
}

const DEFAULT_SORT_BY = 'bar_idx'
const DEFAULT_SORT_ORDER: 'asc' | 'desc' = 'desc'
const CANDLE_LOG_PAGE_SIZES = [10, 20, 50] as const
const DEFAULT_CANDLE_LOG_PAGE_SIZE = CANDLE_LOG_PAGE_SIZES[0]

function createEmptyFilters(): CandleLogFilterState {
  return {
    onlyWithAction: false,
    symbol: '',
    inCooldown: null,
    startTs: null,
    endTs: null,
    equityChangeMin: null,
    equityChangeMax: null,
    equityChangePctMin: null,
    equityChangePctMax: null,
  }
}

function cloneFilters(filters: CandleLogFilterState): CandleLogFilterState {
  return {
    onlyWithAction: Boolean(filters.onlyWithAction),
    symbol: filters.symbol ?? '',
    inCooldown: typeof filters.inCooldown === 'boolean' ? filters.inCooldown : null,
    startTs: filters.startTs ?? null,
    endTs: filters.endTs ?? null,
    equityChangeMin: filters.equityChangeMin ?? null,
    equityChangeMax: filters.equityChangeMax ?? null,
    equityChangePctMin: filters.equityChangePctMin ?? null,
    equityChangePctMax: filters.equityChangePctMax ?? null,
  }
}

export function useBacktestCandleLog(
  selectedRunId: Ref<string | null>,
  activeTab: Ref<string>,
) {
  const message = useMessage()

  const showCandleDetail = ref(false)
  const selectedCandleRow = ref<CandleLogRow | null>(null)

  const candleLogRows = ref<CandleLogRow[]>([])
  const candleLogTotal = ref(0)
  const candleLogLoading = ref(false)
  const filtersDraft = ref<CandleLogFilterState>(createEmptyFilters())
  const filtersApplied = ref<CandleLogFilterState>(createEmptyFilters())
  const candleLogPage = ref(1)
  const candleLogPageSize = ref(DEFAULT_CANDLE_LOG_PAGE_SIZE)
  const candleLogSortBy = ref<CandleLogSortBy>(DEFAULT_SORT_BY)
  const candleLogSortOrder = ref<'asc' | 'desc'>(DEFAULT_SORT_ORDER)
  const candleLogExplicitSort = ref(false)
  const stateByRunId = new Map<string, StoredState>()

  const candleLogPagination = computed(() => ({
    page: candleLogPage.value,
    pageSize: candleLogPageSize.value,
    itemCount: candleLogTotal.value,
    pageSizes: [...CANDLE_LOG_PAGE_SIZES],
    showSizePicker: true,
  }))

  const hasAppliedFilters = computed(() =>
    Boolean(
      filtersApplied.value.onlyWithAction ||
      filtersApplied.value.symbol ||
      filtersApplied.value.startTs ||
      filtersApplied.value.endTs ||
      typeof filtersApplied.value.inCooldown === 'boolean' ||
      filtersApplied.value.equityChangeMin != null ||
      filtersApplied.value.equityChangeMax != null ||
      filtersApplied.value.equityChangePctMin != null ||
      filtersApplied.value.equityChangePctMax != null,
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

  const candleLogColumns = computed(() => {
    const headerOrder = (key: CandleLogSortBy) =>
      candleLogExplicitSort.value && candleLogSortBy.value === key
        ? (candleLogSortOrder.value === 'desc' ? 'descend' : 'ascend')
        : false
    return [
    {
      title: '序号',
      key: 'barIdx',
      width: 80,
      sortOrder: headerOrder('bar_idx'),
      sorter: true,
      render: (_row: CandleLogRow, rowIndex: number) =>
        candleLogTotal.value - (candleLogPage.value - 1) * candleLogPageSize.value - rowIndex,
    },
    {
      title: '时间',
      key: 'ts',
      width: 160,
      sortOrder: headerOrder('ts'),
      sorter: true,
      render: (row: CandleLogRow) => row.ts,
    },
    {
      title: '开盘净值',
      key: 'openEquity',
      width: 100,
      sortOrder: headerOrder('open_equity'),
      sorter: true,
      render: (row: CandleLogRow) => row.openEquity.toFixed(2),
    },
    {
      title: '收盘净值',
      key: 'closeEquity',
      width: 100,
      sortOrder: headerOrder('close_equity'),
      sorter: true,
      render: (row: CandleLogRow) => row.closeEquity.toFixed(2),
    },
    {
      title: '净值变化',
      key: 'equityChange',
      width: 100,
      sortOrder: headerOrder('equity_change'),
      sorter: true,
      render: (row: CandleLogRow) => {
        const v = row.closeEquity - row.openEquity
        return v.toFixed(2)
      },
    },
    {
      title: '净值变化%',
      key: 'equityChangePct',
      width: 110,
      sortOrder: headerOrder('equity_change_pct'),
      sorter: true,
      render: (row: CandleLogRow) => {
        if (row.openEquity === 0) return '—'
        const v = (row.closeEquity - row.openEquity) / row.openEquity * 100
        return `${v.toFixed(2)}%`
      },
    },
    {
      title: '持仓数',
      key: 'posCount',
      width: 80,
      sortOrder: headerOrder('pos_count'),
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
    {
      title: '操作',
      key: 'action',
      width: 70,
      render: (row: CandleLogRow) =>
        h(NButton, {
          size: 'small',
          onClick: () => { selectedCandleRow.value = row; showCandleDetail.value = true },
        }, { default: () => '详情' }),
    },
    ]
  })

  const saveState = (runId: string) => {
    stateByRunId.set(runId, {
      filtersDraft: cloneFilters(filtersDraft.value),
      filtersApplied: cloneFilters(filtersApplied.value),
      page: candleLogPage.value,
      pageSize: candleLogPageSize.value,
      sortBy: candleLogSortBy.value,
      sortOrder: candleLogSortOrder.value,
      explicitSort: candleLogExplicitSort.value,
    })
  }

  const restoreState = (runId: string) => {
    const cached = stateByRunId.get(runId)
    if (!cached) {
      filtersDraft.value = createEmptyFilters()
      filtersApplied.value = createEmptyFilters()
      candleLogPage.value = 1
      candleLogPageSize.value = DEFAULT_CANDLE_LOG_PAGE_SIZE
      candleLogSortBy.value = DEFAULT_SORT_BY
      candleLogSortOrder.value = DEFAULT_SORT_ORDER
      candleLogExplicitSort.value = false
      return
    }
    filtersDraft.value = cloneFilters(cached.filtersDraft)
    filtersApplied.value = cloneFilters(cached.filtersApplied)
    candleLogPage.value = cached.page
    const allowedSizes = CANDLE_LOG_PAGE_SIZES as readonly number[]
    candleLogPageSize.value = allowedSizes.includes(cached.pageSize) ? cached.pageSize : DEFAULT_CANDLE_LOG_PAGE_SIZE
    candleLogSortBy.value = cached.sortBy
    candleLogSortOrder.value = cached.sortOrder
    candleLogExplicitSort.value = cached.explicitSort === true
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
    candleLogExplicitSort.value = false
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
    equityChange: 'equity_change',
    equityChangePct: 'equity_change_pct',
  }

  const onCandleLogSort = (sorterState: DataTableSortState | null) => {
    if (!sorterState || !sorterState.order) {
      candleLogSortBy.value = DEFAULT_SORT_BY
      candleLogSortOrder.value = DEFAULT_SORT_ORDER
      candleLogExplicitSort.value = false
    } else {
      candleLogSortBy.value = keyToSortBy[sorterState.columnKey as string] ?? DEFAULT_SORT_BY
      candleLogSortOrder.value = sorterState.order === 'ascend' ? 'asc' : 'desc'
      candleLogExplicitSort.value = true
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
    showCandleDetail,
    selectedCandleRow,
  }
}
