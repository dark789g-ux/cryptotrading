import { ref, computed, watch, h, type Ref } from 'vue'
import { useMessage, NButton, NSpace, type DataTableSortState } from 'naive-ui'
import {
  backtestApi,
  type CandleLogRow,
  type BacktestCandleLogFilters,
  type BacktestCandleLogTradeState,
} from '../useApi'

type CandleLogFilterState = Omit<BacktestCandleLogFilters, 'tradeStates' | 'inCooldown' | 'isSimulation'> & {
  tradeStates: BacktestCandleLogTradeState[]
  inCooldown: 'true' | 'false' | null
  isSimulation: 'true' | 'false' | null
}
type CandleLogSortBy = 'bar_idx' | 'ts' | 'open_equity' | 'close_equity' | 'pos_count' | 'equity_change' | 'equity_change_pct' | 'cooldown_duration' | 'cooldown_remaining'

interface StoredState {
  filtersDraft: CandleLogFilterState
  filtersApplied: CandleLogFilterState
  page: number
  pageSize: number
  sortBy: CandleLogSortBy
  sortOrder: 'asc' | 'desc'
  explicitSort: boolean
}

const DEFAULT_SORT_BY = 'ts'
const DEFAULT_SORT_ORDER: 'asc' | 'desc' = 'asc'
const CANDLE_LOG_PAGE_SIZES = [10, 20, 50] as const
const DEFAULT_CANDLE_LOG_PAGE_SIZE = CANDLE_LOG_PAGE_SIZES[0]

const DEFAULT_TRADE_STATES: BacktestCandleLogTradeState[] = ['position', 'entry', 'exit']

function createEmptyFilters(): CandleLogFilterState {
  return {
    tradeStates: [...DEFAULT_TRADE_STATES],
    symbol: '',
    inCooldown: null,
    isSimulation: null,
    startTs: null,
    endTs: null,
    equityChangeMin: null,
    equityChangeMax: null,
    equityChangePctMin: null,
    equityChangePctMax: null,
    cooldownDurationMin: null,
    cooldownDurationMax: null,
    cooldownRemainingMin: null,
    cooldownRemainingMax: null,
  }
}

function cloneTradeStates(raw: unknown): BacktestCandleLogTradeState[] {
  if (raw === undefined) return [...DEFAULT_TRADE_STATES]
  if (raw == null || !Array.isArray(raw)) return []
  return raw.filter((t): t is BacktestCandleLogTradeState =>
    t === 'position' || t === 'entry' || t === 'exit')
}

function cloneFilters(filters: CandleLogFilterState): CandleLogFilterState {
  return {
    tradeStates: cloneTradeStates(filters.tradeStates as unknown),
    symbol: filters.symbol ?? '',
    inCooldown: filters.inCooldown ?? null,
    isSimulation: filters.isSimulation ?? null,
    startTs: filters.startTs ?? null,
    endTs: filters.endTs ?? null,
    equityChangeMin: filters.equityChangeMin ?? null,
    equityChangeMax: filters.equityChangeMax ?? null,
    equityChangePctMin: filters.equityChangePctMin ?? null,
    equityChangePctMax: filters.equityChangePctMax ?? null,
    cooldownDurationMin: filters.cooldownDurationMin ?? null,
    cooldownDurationMax: filters.cooldownDurationMax ?? null,
    cooldownRemainingMin: filters.cooldownRemainingMin ?? null,
    cooldownRemainingMax: filters.cooldownRemainingMax ?? null,
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
  const candleLogGrandTotal = ref(0)
  const candleLogLoading = ref(false)
  const filtersDraft = ref<CandleLogFilterState>(createEmptyFilters())
  const filtersApplied = ref<CandleLogFilterState>(createEmptyFilters())
  const candleLogPage = ref(1)
  const candleLogPageSize = ref<number>(DEFAULT_CANDLE_LOG_PAGE_SIZE)
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
      (filtersApplied.value.tradeStates?.length ?? 0) > 0 ||
      filtersApplied.value.symbol ||
      filtersApplied.value.startTs ||
      filtersApplied.value.endTs ||
      filtersApplied.value.inCooldown !== null ||
      filtersApplied.value.isSimulation !== null ||
      filtersApplied.value.equityChangeMin != null ||
      filtersApplied.value.equityChangeMax != null ||
      filtersApplied.value.equityChangePctMin != null ||
      filtersApplied.value.equityChangePctMax != null ||
      filtersApplied.value.cooldownDurationMin != null ||
      filtersApplied.value.cooldownDurationMax != null ||
      filtersApplied.value.cooldownRemainingMin != null ||
      filtersApplied.value.cooldownRemainingMax != null,
    ),
  )
  const emptyText = computed(() => (
    hasAppliedFilters.value ? '当前筛选条件下无数据' : '该历史回测未记录K线日志'
  ))

  const loadGrandTotal = async () => {
    if (!selectedRunId.value) return
    try {
      const res = await backtestApi.getCandleLog(selectedRunId.value, {
        page: 1,
        pageSize: 1,
        sortBy: DEFAULT_SORT_BY,
        sortOrder: DEFAULT_SORT_ORDER,
      })
      candleLogGrandTotal.value = res.total
    } catch {
      // silently ignore
    }
  }

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
      const { inCooldown: inCooldownStr, isSimulation: isSimulationStr, ...restFilters } = filtersApplied.value
      const res = await backtestApi.getCandleLog(selectedRunId.value, {
        page: candleLogPage.value,
        pageSize: candleLogPageSize.value,
        ...restFilters,
        inCooldown: inCooldownStr === null ? null : inCooldownStr === 'true',
        isSimulation: isSimulationStr === null ? null : isSimulationStr === 'true',
        sortBy: candleLogSortBy.value,
        sortOrder: candleLogSortOrder.value,
      })
      candleLogRows.value = res.rows
      candleLogTotal.value = res.total
      if (!hasAppliedFilters.value) candleLogGrandTotal.value = res.total
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      candleLogLoading.value = false
    }
  }

  const loadCandleLogTotalOnly = async () => {
    if (!selectedRunId.value) return
    try {
      const { inCooldown: inCooldownStr2, isSimulation: isSimulationStr2, ...restFilters2 } = filtersApplied.value
      const res = await backtestApi.getCandleLog(selectedRunId.value, {
        page: 1,
        pageSize: 1,
        ...restFilters2,
        inCooldown: inCooldownStr2 === null ? null : inCooldownStr2 === 'true',
        isSimulation: isSimulationStr2 === null ? null : isSimulationStr2 === 'true',
        sortBy: candleLogSortBy.value,
        sortOrder: candleLogSortOrder.value,
      })
      candleLogTotal.value = res.total
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  const applyFilters = () => {
    if (!validateFilters()) return
    filtersApplied.value = cloneFilters(filtersDraft.value)
    candleLogPage.value = 1
    if (selectedRunId.value) saveState(selectedRunId.value)
    loadCandleLog()
  }

  const jumpCandleLogFromRow = (row: CandleLogRow) => {
    if (typeof row.ts !== 'string' || !row.ts.trim()) {
      message.error('该行时间为空，无法以此起点查询')
      return
    }
    filtersDraft.value = createEmptyFilters()
    filtersDraft.value.startTs = row.ts.trim()
    applyFilters()
  }

  const candleLogColumns = computed(() => {
    const opDisabled = candleLogLoading.value
    type NaiveSortOrder = 'ascend' | 'descend' | false
    const headerOrder = (key: CandleLogSortBy): NaiveSortOrder =>
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
        render: (row: CandleLogRow) => String(row.barIdx + 1),
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
        render: (row: CandleLogRow) => row.entries.length === 0 ? '—' : `${row.entries.length} 条`,
      },
      {
        title: '出场',
        key: 'exits',
        width: 90,
        render: (row: CandleLogRow) => row.exits.length === 0 ? '—' : `${row.exits.length} 条`,
      },
      {
        title: '模拟/实盘',
        key: 'isSimulation',
        width: 90,
        render: (row: CandleLogRow) => {
          const lastExit = row.exits[row.exits.length - 1] as { isSimulation?: boolean } | undefined
          if (!lastExit) return '—'
          return lastExit.isSimulation ? '模拟' : '实盘'
        },
      },
      {
        title: '整体收益率',
        key: 'overallReturnPct',
        width: 100,
        render: (row: CandleLogRow) => {
          const lastExit = row.exits[row.exits.length - 1] as { overallReturnPct?: number } | undefined
          if (lastExit?.overallReturnPct == null) return '—'
          return `${lastExit.overallReturnPct.toFixed(2)}%`
        },
      },
      {
        title: '累计胜率',
        key: 'cumulativeWinRate',
        width: 90,
        render: (row: CandleLogRow) => {
          const lastExit = row.exits[row.exits.length - 1] as { cumulativeWinRate?: number } | undefined
          if (lastExit?.cumulativeWinRate == null) return '—'
          return `${((lastExit.cumulativeWinRate ?? 0) * 100).toFixed(1)}%`
        },
      },
      {
        title: '累计赔率',
        key: 'cumulativeOdds',
        width: 90,
        render: (row: CandleLogRow) => {
          const lastExit = row.exits[row.exits.length - 1] as { cumulativeOdds?: number } | undefined
          if (lastExit?.cumulativeOdds == null) return '—'
          return (lastExit.cumulativeOdds ?? 0).toFixed(2)
        },
      },
      {
        title: '窗口胜率',
        key: 'windowWinRate',
        width: 90,
        render: (row: CandleLogRow) => {
          const lastExit = row.exits[row.exits.length - 1] as { windowWinRate?: number } | undefined
          if (lastExit?.windowWinRate == null) return '—'
          return `${((lastExit.windowWinRate ?? 0) * 100).toFixed(1)}%`
        },
      },
      {
        title: '窗口赔率',
        key: 'windowOdds',
        width: 90,
        render: (row: CandleLogRow) => {
          const lastExit = row.exits[row.exits.length - 1] as { windowOdds?: number } | undefined
          if (lastExit?.windowOdds == null) return '—'
          return (lastExit.windowOdds ?? 0).toFixed(2)
        },
      },
      {
        title: '冷却中',
        key: 'inCooldown',
        width: 80,
        render: (row: CandleLogRow) => (row.inCooldown ? '是' : '否'),
      },
      {
        title: '冷却期长度',
        key: 'cooldownDuration',
        width: 100,
        sortOrder: headerOrder('cooldown_duration'),
        sorter: true,
        render: (row: CandleLogRow) => row.cooldownDuration == null ? '—' : String(row.cooldownDuration),
      },
      {
        title: '剩余冷却',
        key: 'cooldownRemaining',
        width: 90,
        sortOrder: headerOrder('cooldown_remaining'),
        sorter: true,
        render: (row: CandleLogRow) => row.cooldownRemaining == null ? '—' : String(row.cooldownRemaining),
      },
      {
        title: '操作',
        key: 'action',
        width: 260,
        render: (row: CandleLogRow) =>
          h(NSpace, { size: 8, wrap: false }, {
            default: () => [
              h(NButton, {
                size: 'small',
                disabled: opDisabled,
                onClick: () => { selectedCandleRow.value = row; showCandleDetail.value = true },
              }, { default: () => '详情' }),
              h(NButton, {
                size: 'small',
                disabled: opDisabled,
                onClick: () => jumpCandleLogFromRow(row),
              }, { default: () => '以此为起点查询' }),
            ],
          }),
      },
    ]
  })

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
    cooldownDuration: 'cooldown_duration',
    cooldownRemaining: 'cooldown_remaining',
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

  const candleLogRowProps = (row: CandleLogRow) => {
    if (row.cooldownRemaining != null && row.cooldownRemaining > 0) {
      return { style: 'background: rgba(255, 165, 0, 0.10);' }
    }
    return {}
  }

  watch(
    () => filtersDraft.value.tradeStates,
    (ts) => {
      if (ts == null) {
        filtersDraft.value.tradeStates = []
      }
    },
  )

  watch(filtersDraft, () => {
    if (selectedRunId.value && activeTab.value === 'candleLog') saveState(selectedRunId.value)
  }, { deep: true })

  watch([selectedRunId, activeTab], ([id, tab], [prevId, prevTab]) => {
    if (prevId && prevTab === 'candleLog') saveState(prevId)
    if (!id) {
      candleLogRows.value = []
      candleLogTotal.value = 0
      candleLogGrandTotal.value = 0
      return
    }
    restoreState(id)
    void loadGrandTotal()
    if (tab === 'candleLog') {
      loadCandleLog()
      return
    }
    candleLogRows.value = []
    void loadCandleLogTotalOnly()
  }, { immediate: true })

  return {
    candleLogRows,
    candleLogTotal,
    candleLogGrandTotal,
    candleLogLoading,
    candleLogPage,
    candleLogPageSize,
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
    candleLogRowProps,
  }
}
