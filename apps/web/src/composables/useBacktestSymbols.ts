import { ref, computed, watch, type Ref } from 'vue'
import { useMessage, type DataTableSortState } from 'naive-ui'
import { backtestApi, type BacktestSymbolFilters } from './useApi'

type SymbolFilterState = BacktestSymbolFilters

interface StoredState {
  filtersDraft: SymbolFilterState
  filtersApplied: SymbolFilterState
  page: number
  pageSize: number
  sortBy: string
  sortOrder: 'asc' | 'desc'
  explicitSort: boolean
}

const DEFAULT_SORT_BY = 'totalPnl'
const DEFAULT_SORT_ORDER: 'asc' | 'desc' = 'desc'

function createEmptyFilters(): SymbolFilterState {
  return {
    symbol: '',
    totalPnlMin: null,
    totalPnlMax: null,
    winRateMin: null,
    winRateMax: null,
  }
}

function cloneFilters(filters: SymbolFilterState): SymbolFilterState {
  return {
    symbol: filters.symbol ?? '',
    totalPnlMin: filters.totalPnlMin ?? null,
    totalPnlMax: filters.totalPnlMax ?? null,
    winRateMin: filters.winRateMin ?? null,
    winRateMax: filters.winRateMax ?? null,
  }
}

export function useBacktestSymbols(
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
  const filtersDraft = ref<SymbolFilterState>(createEmptyFilters())
  const filtersApplied = ref<SymbolFilterState>(createEmptyFilters())
  const stateByRunId = new Map<string, StoredState>()

  const pagination = computed(() => ({
    page: page.value,
    pageSize: pageSize.value,
    itemCount: total.value,
    pageSizes: [10, 20, 50],
    showSizePicker: true,
  }))

  const hasAppliedFilters = computed(() => Object.values(filtersApplied.value).some((value) => value !== '' && value !== null))
  const emptyText = computed(() => (hasAppliedFilters.value ? '当前筛选条件下无数据' : '暂无标的盈亏统计'))

  const columns = computed(() => {
    const headerOrder = (key: string) =>
      explicitSort.value && sortBy.value === key
        ? (sortOrder.value === 'desc' ? 'descend' : 'ascend')
        : false
    return [
      { title: '标的', key: 'symbol', width: 130, sortOrder: false as const, sorter: false },
      {
        title: '仓位数',
        key: 'posCount',
        width: 80,
        sortOrder: headerOrder('posCount'),
        sorter: true,
      },
      {
        title: '胜率',
        key: 'winRate',
        width: 80,
        sortOrder: headerOrder('winRate'),
        sorter: true,
        render: (r: any) => `${r.winRate}%`,
      },
      {
        title: '总盈亏',
        key: 'totalPnl',
        width: 110,
        sortOrder: headerOrder('totalPnl'),
        sorter: true,
        render: (r: any) => r.totalPnl?.toFixed(2),
      },
      {
        title: '平均收益',
        key: 'avgReturn',
        width: 90,
        sortOrder: headerOrder('avgReturn'),
        sorter: true,
        render: (r: any) => `${r.avgReturn?.toFixed(2)}%`,
      },
      {
        title: '最佳',
        key: 'bestReturn',
        width: 80,
        sortOrder: headerOrder('bestReturn'),
        sorter: true,
        render: (r: any) => `${r.bestReturn?.toFixed(2)}%`,
      },
      {
        title: '最差',
        key: 'worstReturn',
        width: 80,
        sortOrder: headerOrder('worstReturn'),
        sorter: true,
        render: (r: any) => `${r.worstReturn?.toFixed(2)}%`,
      },
      {
        title: '均持根数',
        key: 'avgHold',
        width: 80,
        sortOrder: headerOrder('avgHold'),
        sorter: true,
      },
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

  const load = async () => {
    if (!selectedRunId.value) return
    loading.value = true
    try {
      const res = await backtestApi.getRunSymbols(selectedRunId.value, {
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

  const applyFilters = () => {
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
    if (selectedRunId.value && activeTab.value === 'symbols') saveState(selectedRunId.value)
  }, { deep: true })

  watch([selectedRunId, activeTab], ([id, tab], [prevId, prevTab]) => {
    if (prevId && prevTab === 'symbols') saveState(prevId)
    if (id && tab === 'symbols') {
      restoreState(id)
      load()
    }
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
