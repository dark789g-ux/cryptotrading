import { ref, computed, watch, type Ref } from 'vue'
import { useMessage, type DataTableSortState } from 'naive-ui'
import { backtestApi, type BacktestPositionFilters } from '../useApi'

type PositionFilterState = BacktestPositionFilters

interface StoredState {
  filtersDraft: PositionFilterState
  filtersApplied: PositionFilterState
  page: number
  pageSize: number
  sortBy: string
  sortOrder: 'asc' | 'desc'
  /** 用户是否通过表头操作过排序（与程序默认同列同向时仍为 true） */
  explicitSort: boolean
}

const DEFAULT_SORT_BY = 'entryTime'
const DEFAULT_SORT_ORDER: 'asc' | 'desc' = 'asc'

function createEmptyFilters(): PositionFilterState {
  return {
    symbol: '',
    pnlMin: null,
    pnlMax: null,
    returnPctMin: null,
    returnPctMax: null,
    stopType: '',
    entryStart: null,
    entryEnd: null,
    closeStart: null,
    closeEnd: null,
  }
}

function cloneFilters(filters: PositionFilterState): PositionFilterState {
  return {
    symbol: filters.symbol ?? '',
    pnlMin: filters.pnlMin ?? null,
    pnlMax: filters.pnlMax ?? null,
    returnPctMin: filters.returnPctMin ?? null,
    returnPctMax: filters.returnPctMax ?? null,
    stopType: filters.stopType ?? '',
    entryStart: filters.entryStart ?? null,
    entryEnd: filters.entryEnd ?? null,
    closeStart: filters.closeStart ?? null,
    closeEnd: filters.closeEnd ?? null,
  }
}

function hasRangeError(start?: string, end?: string) {
  return Boolean(start && end && start > end)
}

export function useBacktestPositions(
  selectedRunId: Ref<string | null>,
  activeTab: Ref<string>,
) {
  const message = useMessage()

  const rows = ref<any[]>([])
  const total = ref(0)
  const loading = ref(false)
  const page = ref(1)
  const pageSize = ref(10)
  const sortBy = ref(DEFAULT_SORT_BY)
  const sortOrder = ref<'asc' | 'desc'>(DEFAULT_SORT_ORDER)
  const explicitSort = ref(false)
  const filtersDraft = ref<PositionFilterState>(createEmptyFilters())
  const filtersApplied = ref<PositionFilterState>(createEmptyFilters())
  const stateByRunId = new Map<string, StoredState>()

  const pagination = computed(() => ({
    page: page.value,
    pageSize: pageSize.value,
    itemCount: total.value,
    pageSizes: [10, 20, 50],
    showSizePicker: true,
  }))

  const hasAppliedFilters = computed(() => Object.values(filtersApplied.value).some((value) => value !== '' && value !== null))
  const emptyText = computed(() => (hasAppliedFilters.value ? '当前筛选条件下无数据' : '暂无仓位记录'))

  const columns = computed(() => {
    type NaiveSortOrder = 'ascend' | 'descend' | false
    const headerOrder = (key: string): NaiveSortOrder =>
      explicitSort.value && sortBy.value === key
        ? (sortOrder.value === 'desc' ? 'descend' : 'ascend')
        : false
    return [
      { title: '#', key: 'posNo', width: 50, sortOrder: false as const, sorter: false },
      { title: '标的', key: 'symbol', width: 120, sortOrder: false as const, sorter: false },
      {
        title: '买入时间',
        key: 'entryTime',
        width: 150,
        sortOrder: headerOrder('entryTime'),
        sorter: true,
      },
      {
        title: '买入价',
        key: 'entryPrice',
        width: 100,
        sortOrder: headerOrder('entryPrice'),
        sorter: true,
      },
      {
        title: '平仓时间',
        key: 'closeTime',
        width: 150,
        sortOrder: headerOrder('closeTime'),
        sorter: true,
      },
      {
        title: '平均卖价',
        key: 'sellPrice',
        width: 100,
        sortOrder: headerOrder('sellPrice'),
        sorter: true,
      },
      {
        title: '盈亏(USDT)',
        key: 'pnl',
        width: 110,
        sortOrder: headerOrder('pnl'),
        sorter: true,
        render: (r: any) => r.pnl?.toFixed(2) ?? '-',
      },
      {
        title: '收益率',
        key: 'returnPct',
        width: 90,
        sortOrder: headerOrder('returnPct'),
        sorter: true,
        render: (r: any) => `${r.returnPct?.toFixed(2)}%`,
      },
      {
        title: '持仓根数',
        key: 'holdCandles',
        width: 90,
        sortOrder: headerOrder('holdCandles'),
        sorter: true,
      },
      {
        title: '状态',
        key: 'isSimulation',
        width: 80,
        sortOrder: false as const,
        sorter: false,
        render: (r: any) => {
          if (r.tradePhase === 'probe') return '探针'
          if (r.tradePhase === 'simulation') return '模拟'
          if (r.tradePhase === 'live') return '实盘'
          return r.isSimulation ? '模拟' : '实盘'
        },
      },
      {
        title: '整体收益率',
        key: 'overallReturnPct',
        width: 100,
        sortOrder: headerOrder('overallReturnPct'),
        sorter: true,
        render: (r: any) => `${r.overallReturnPct?.toFixed(2) ?? '-'}%`,
      },
      {
        title: '累计胜率',
        key: 'cumulativeWinRate',
        width: 90,
        sortOrder: headerOrder('cumulativeWinRate'),
        sorter: true,
        render: (r: any) => `${((r.cumulativeWinRate ?? 0) * 100).toFixed(1)}%`,
      },
      {
        title: '累计赔率',
        key: 'cumulativeOdds',
        width: 90,
        sortOrder: headerOrder('cumulativeOdds'),
        sorter: true,
        render: (r: any) => (r.cumulativeOdds ?? 0).toFixed(2),
      },
      {
        title: '窗口胜率',
        key: 'windowWinRate',
        width: 90,
        sortOrder: headerOrder('windowWinRate'),
        sorter: true,
        render: (r: any) => `${((r.windowWinRate ?? 0) * 100).toFixed(1)}%`,
      },
      {
        title: '窗口赔率',
        key: 'windowOdds',
        width: 90,
        sortOrder: headerOrder('windowOdds'),
        sorter: true,
        render: (r: any) => (r.windowOdds ?? 0).toFixed(2),
      },
      { title: '出场原因', key: 'stopTypes', ellipsis: { tooltip: true as const }, render: (r: any) => r.stopTypes?.join(' / ') ?? '-' },
    ]
  })

  const saveState = (runId: string) => {
    stateByRunId.set(runId, {
      filtersDraft: cloneFilters(filtersDraft.value),
      filtersApplied: cloneFilters(filtersApplied.value),
      page: page.value,
      pageSize: pageSize.value,
      sortBy: sortBy.value,
      sortOrder: sortOrder.value,
      explicitSort: explicitSort.value,
    })
  }

  const restoreState = (runId: string) => {
    const cached = stateByRunId.get(runId)
    if (!cached) {
      filtersDraft.value = createEmptyFilters()
      filtersApplied.value = createEmptyFilters()
      page.value = 1
      pageSize.value = 10
      sortBy.value = DEFAULT_SORT_BY
      sortOrder.value = DEFAULT_SORT_ORDER
      explicitSort.value = false
      return
    }
    filtersDraft.value = cloneFilters(cached.filtersDraft)
    filtersApplied.value = cloneFilters(cached.filtersApplied)
    page.value = cached.page
    pageSize.value = cached.pageSize
    sortBy.value = cached.sortBy
    sortOrder.value = cached.sortOrder
    explicitSort.value = cached.explicitSort === true
  }

  const validateFilters = () => {
    if (hasRangeError(filtersDraft.value.entryStart, filtersDraft.value.entryEnd)) {
      message.error('买入开始时间不能晚于结束时间')
      return false
    }
    if (hasRangeError(filtersDraft.value.closeStart, filtersDraft.value.closeEnd)) {
      message.error('平仓开始时间不能晚于结束时间')
      return false
    }
    return true
  }

  const load = async () => {
    if (!selectedRunId.value) return
    loading.value = true
    try {
      const res = await backtestApi.getRunPositions(selectedRunId.value, {
        page: page.value,
        pageSize: pageSize.value,
        sortBy: sortBy.value,
        sortOrder: sortOrder.value.toUpperCase() as 'ASC' | 'DESC',
        ...filtersApplied.value,
      })
      rows.value = res.rows
      total.value = res.total
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      loading.value = false
    }
  }

  /** 抽屉打开或切换 run 时预取条数，使 tab 标题无需切 tab 即可显示 total */
  const loadTotalOnly = async () => {
    if (!selectedRunId.value) return
    try {
      const res = await backtestApi.getRunPositions(selectedRunId.value, {
        page: 1,
        pageSize: 1,
        sortBy: sortBy.value,
        sortOrder: sortOrder.value.toUpperCase() as 'ASC' | 'DESC',
        ...filtersApplied.value,
      })
      total.value = res.total
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const applyFilters = () => {
    if (!validateFilters()) return
    filtersApplied.value = cloneFilters(filtersDraft.value)
    page.value = 1
    if (selectedRunId.value) saveState(selectedRunId.value)
    load()
  }

  const resetFilters = () => {
    filtersDraft.value = createEmptyFilters()
    filtersApplied.value = createEmptyFilters()
    page.value = 1
    sortBy.value = DEFAULT_SORT_BY
    sortOrder.value = DEFAULT_SORT_ORDER
    explicitSort.value = false
    if (selectedRunId.value) saveState(selectedRunId.value)
    load()
  }

  const onPage = (p: number) => {
    page.value = p
    if (selectedRunId.value) saveState(selectedRunId.value)
    load()
  }

  const onPageSize = (ps: number) => {
    pageSize.value = ps
    page.value = 1
    if (selectedRunId.value) saveState(selectedRunId.value)
    load()
  }

  const onSort = (sorterState: DataTableSortState | null) => {
    if (!sorterState || !sorterState.order) {
      sortBy.value = DEFAULT_SORT_BY
      sortOrder.value = DEFAULT_SORT_ORDER
      explicitSort.value = false
    } else {
      sortBy.value = String(sorterState.columnKey)
      sortOrder.value = sorterState.order === 'ascend' ? 'asc' : 'desc'
      explicitSort.value = true
    }
    page.value = 1
    if (selectedRunId.value) saveState(selectedRunId.value)
    load()
  }

  watch(filtersDraft, () => {
    if (selectedRunId.value && activeTab.value === 'positions') saveState(selectedRunId.value)
  }, { deep: true })

  watch([selectedRunId, activeTab], ([id, tab], [prevId, prevTab]) => {
    if (prevId && prevTab === 'positions') saveState(prevId)
    if (!id) {
      rows.value = []
      total.value = 0
      return
    }
    restoreState(id)
    if (tab === 'positions') {
      load()
      return
    }
    rows.value = []
    void loadTotalOnly()
  }, { immediate: true })

  return {
    rows,
    total,
    loading,
    pagination,
    columns,
    filtersDraft,
    filtersApplied,
    hasAppliedFilters,
    emptyText,
    load,
    applyFilters,
    resetFilters,
    onPage,
    onPageSize,
    onSort,
  }
}
