import { computed, onBeforeUnmount, ref } from 'vue'
import { useMessage, useDialog } from 'naive-ui'
import { strategyApi, backtestApi, type BacktestProgress } from '@/api'
import type { HubBacktestRow } from '@/components/backtest/hubTypes'

type StrategyRow = {
  id: string
  name: string
  typeId: string
  timeframe?: string
  createdAt: string
  lastBacktestAt?: string | null
  lastBacktestReturn?: number | null
  symbols?: string[]
}

function formatPercent(val: number | null | undefined) {
  if (val == null) return '-'
  return `${val >= 0 ? '+' : ''}${val.toFixed(2)}%`
}

export function toCryptoHubRow(row: StrategyRow): HubBacktestRow {
  return {
    key: `crypto:${row.id}`,
    id: row.id,
    market: 'crypto',
    name: row.name,
    subtitle: row.timeframe || ({ ma_kdj: 'MA+KDJ' }[row.typeId] ?? row.typeId),
    statusLabel: row.lastBacktestAt ? '有回测' : '未回测',
    statusType: row.lastBacktestAt ? 'success' : 'default',
    metric: formatPercent(row.lastBacktestReturn),
    createdAt: row.createdAt,
    createdAtMs: new Date(row.createdAt).getTime() || 0,
  }
}

export function useHubCryptoBacktest() {
  const message = useMessage()
  const dialog = useDialog()

  const strategies = ref<StrategyRow[]>([])
  const loading = ref(false)
  const page = ref(1)
  const pageSize = ref(20)
  const total = ref(0)
  const sortField = ref('createdAt')
  const sortOrder = ref<'ASC' | 'DESC'>('DESC')

  const showEditModal = ref(false)
  const editingStrategy = ref<StrategyRow | null>(null)
  const showDetailDrawer = ref(false)
  const selectedStrategy = ref<StrategyRow | null>(null)
  const latestRun = ref<unknown>(null)
  const detailLoading = ref(false)

  const showProgressModal = ref(false)
  const progressModalStrategyId = ref<string | null>(null)
  const progressModalStrategyName = ref('')
  const progressModalData = ref<BacktestProgress | null>(null)
  const progressMap = ref<Record<string, BacktestProgress>>({})
  const pollErrorCount: Record<string, number> = {}
  const pollingIds = ref(new Set<string>())
  let pollTimer: ReturnType<typeof setInterval> | null = null

  const hubRows = computed(() => strategies.value.map(toCryptoHubRow))
  const isProgressRunning = computed(() =>
    !!progressModalStrategyId.value && pollingIds.value.has(progressModalStrategyId.value),
  )

  async function loadList(keyword?: string) {
    loading.value = true
    try {
      const res = await strategyApi.getStrategies(sortField.value, sortOrder.value, page.value, pageSize.value)
      let rows = res.rows as StrategyRow[]
      if (keyword?.trim()) {
        const q = keyword.trim().toLowerCase()
        rows = rows.filter((r) => r.name.toLowerCase().includes(q))
      }
      strategies.value = rows
      total.value = res.total
    } catch (err: unknown) {
      message.error((err as Error).message)
    } finally {
      loading.value = false
    }
  }

  async function openDetail(id: string) {
    showDetailDrawer.value = true
    detailLoading.value = true
    selectedStrategy.value = null
    try {
      const [full, runs] = await Promise.all([
        strategyApi.getStrategy(id),
        backtestApi.listRuns(id),
      ])
      selectedStrategy.value = full as StrategyRow
      latestRun.value = runs[0] ?? null
    } catch (err: unknown) {
      latestRun.value = null
      message.error((err as Error).message)
    } finally {
      detailLoading.value = false
    }
  }

  async function openEdit(id: string) {
    try {
      editingStrategy.value = (await strategyApi.getStrategy(id)) as StrategyRow
      showEditModal.value = true
    } catch (err: unknown) {
      message.error((err as Error).message)
    }
  }

  function confirmDelete(id: string, name: string, onDone?: () => void) {
    dialog.warning({
      title: '确认删除',
      content: `确定要删除策略 "${name}" 吗？`,
      positiveText: '删除',
      negativeText: '取消',
      onPositiveClick: async () => {
        try {
          await strategyApi.deleteStrategy(id)
          message.success('删除成功')
          await loadList()
          onDone?.()
        } catch (err: unknown) {
          message.error((err as Error).message)
        }
      },
    })
  }

  function checkStopTimer() {
    if (!pollingIds.value.size && pollTimer !== null) {
      clearInterval(pollTimer)
      pollTimer = null
    }
  }

  async function pollTick() {
    for (const id of pollingIds.value) {
      try {
        const p = await backtestApi.getProgress(id)
        pollErrorCount[id] = 0
        if (!p) {
          pollingIds.value.delete(id)
          const updated = { ...progressMap.value }
          delete updated[id]
          progressMap.value = updated
          checkStopTimer()
          continue
        }
        progressMap.value = { ...progressMap.value, [id]: p }
        if (progressModalStrategyId.value === id) progressModalData.value = p
        if (p.status === 'done' || p.status === 'error') {
          pollingIds.value.delete(id)
          checkStopTimer()
          if (p.status === 'done') {
            message.success('回测完成')
            if (p.runId && showDetailDrawer.value && selectedStrategy.value?.id === id) {
              backtestApi.getRun(p.runId).then((r) => (latestRun.value = r))
            }
          } else {
            message.error(p.message || '回测失败')
          }
          await loadList()
        }
      } catch {
        pollErrorCount[id] = (pollErrorCount[id] ?? 0) + 1
        if (pollErrorCount[id] >= 3) {
          const errProgress = { ...progressMap.value[id], status: 'error' as const, message: '进度查询失败' }
          progressMap.value = { ...progressMap.value, [id]: errProgress }
          if (progressModalStrategyId.value === id) progressModalData.value = errProgress
          pollingIds.value.delete(id)
          checkStopTimer()
        }
      }
    }
  }

  function startPolling(strategyId: string) {
    pollingIds.value.add(strategyId)
    pollErrorCount[strategyId] = 0
    if (!pollTimer) {
      void pollTick()
      pollTimer = setInterval(() => void pollTick(), 500)
    }
  }

  async function openRun(id: string, name: string) {
    if (pollingIds.value.has(id)) {
      progressModalStrategyId.value = id
      progressModalStrategyName.value = name
      progressModalData.value = progressMap.value[id] ?? null
      showProgressModal.value = true
      return
    }
    let full: StrategyRow
    try {
      full = (await strategyApi.getStrategy(id)) as StrategyRow
    } catch (err: unknown) {
      message.error((err as Error).message)
      return
    }
    if (!full.symbols?.length) {
      message.warning('该策略尚未配置标的，请先编辑策略选择标的')
      return
    }
    const result = await backtestApi.start(full.id, full.symbols)
    if (!result.ok) {
      message.warning(result.message || '启动失败')
      return
    }
    const initProgress: BacktestProgress = {
      status: 'running', phase: '初始化', percent: 0,
      currentTs: null, startTs: null, endTs: null,
      elapsedMs: 0, etaMs: null,
    }
    progressMap.value = { ...progressMap.value, [full.id]: initProgress }
    progressModalData.value = initProgress
    startPolling(full.id)
    progressModalStrategyId.value = full.id
    progressModalStrategyName.value = full.name
    showProgressModal.value = true
  }

  onBeforeUnmount(() => {
    if (pollTimer !== null) clearInterval(pollTimer)
  })

  return {
    strategies,
    hubRows,
    loading,
    page,
    pageSize,
    total,
    showEditModal,
    editingStrategy,
    showDetailDrawer,
    selectedStrategy,
    latestRun,
    detailLoading,
    showProgressModal,
    progressModalStrategyName,
    progressModalData,
    isProgressRunning,
    pollingIds,
    loadList,
    openDetail,
    openEdit,
    confirmDelete,
    openRun,
  }
}
