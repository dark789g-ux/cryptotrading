import { computed, ref } from 'vue'
import { useMessage, useDialog } from 'naive-ui'
import { strategyApi, backtestApi, type BacktestProgress } from '@/api'
import { useBacktestPolling } from './useBacktestPolling'
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
  const progressModalStrategyName = ref('')

  const {
    progressMap,
    pollingIds,
    isProgressRunning,
    progressModalStrategyId,
    progressModalData,
    startPolling,
  } = useBacktestPolling({
    onComplete(id, runId) {
      const p = progressMap.value[id]
      if (p?.status === 'done') {
        message.success('回测完成')
        if (runId && showDetailDrawer.value && selectedStrategy.value?.id === id) {
          backtestApi.getRun(runId).then((r) => (latestRun.value = r))
        }
      } else if (p?.status === 'error') {
        message.error(p.message || '回测失败')
      }
      loadList()
    },
  })

  const hubRows = computed(() => strategies.value.map(toCryptoHubRow))

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
