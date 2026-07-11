import { computed, onUnmounted, ref } from 'vue'
import { useMessage } from 'naive-ui'
import {
  regimeBacktestApi,
  type RegimeBacktestRun,
  type RegimeBacktestDaily,
  type RegimeBacktestTrade,
} from '@/api/modules/strategy/regimeEngine'
import type { HubBacktestRow } from '@/components/backtest/hubTypes'

function fmtPct(val: number | null): string {
  if (val == null || !Number.isFinite(val)) return '-'
  return `${(val * 100).toFixed(2)}%`
}

function fmtRange(start: string, end: string): string {
  const f = (d: string) => `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  return `${f(start)} ~ ${f(end)}`
}

function statusLabel(run: RegimeBacktestRun): string {
  switch (run.status) {
    case 'pending': return '等待中'
    case 'running': return run.phase ?? '运行中'
    case 'completed': return '已完成'
    case 'failed': return '失败'
    default: return run.status
  }
}

function statusType(run: RegimeBacktestRun): HubBacktestRow['statusType'] {
  switch (run.status) {
    case 'pending': return 'default'
    case 'running': return 'info'
    case 'completed': return 'success'
    case 'failed': return 'error'
    default: return 'default'
  }
}

function canRunStatus(status: RegimeBacktestRun['status']): boolean {
  return status === 'pending' || status === 'failed'
}

function canEditStatus(status: RegimeBacktestRun['status']): boolean {
  return status === 'pending' || status === 'failed'
}

export function toAshareHubRow(run: RegimeBacktestRun): HubBacktestRow {
  return {
    key: `ashare:${run.id}`,
    id: run.id,
    market: 'ashare',
    name: run.name,
    subtitle: fmtRange(run.dateStart, run.dateEnd),
    statusLabel: statusLabel(run),
    statusType: statusType(run),
    metric: fmtPct(run.totalRet),
    createdAt: run.createdAt,
    createdAtMs: new Date(run.createdAt).getTime() || 0,
  }
}

export function useHubAshareBacktest() {
  const message = useMessage()
  const runs = ref<RegimeBacktestRun[]>([])
  const total = ref(0)
  const loading = ref(false)
  const page = ref(1)
  const pageSize = ref(20)

  const showDetail = ref(false)
  const detailRun = ref<RegimeBacktestRun | null>(null)
  const detailInitialCapital = ref(1000000)
  const dailyRows = ref<RegimeBacktestDaily[]>([])
  const dailyLoading = ref(false)
  const tradesRows = ref<RegimeBacktestTrade[]>([])
  const tradesLoading = ref(false)

  const showEditModal = ref(false)
  const editingRunId = ref<string | null>(null)

  const progressTimers = ref<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const pollingIds = ref(new Set<string>())
  const hubRows = computed(() => runs.value.map(toAshareHubRow))

  function getRunStatus(id: string): RegimeBacktestRun['status'] | undefined {
    return runs.value.find((r) => r.id === id)?.status
  }

  function canRun(id: string): boolean {
    const status = getRunStatus(id)
    return !!status && canRunStatus(status) && !pollingIds.value.has(id)
  }

  function canEdit(id: string): boolean {
    const status = getRunStatus(id)
    return !!status && canEditStatus(status)
  }

  async function loadList(filter?: { status?: string; keyword?: string }) {
    loading.value = true
    try {
      const result = await regimeBacktestApi.list(page.value, pageSize.value, {
        status: filter?.status || undefined,
        keyword: filter?.keyword || undefined,
      })
      runs.value = result.items
      total.value = result.total
      // 仅对已在跑的任务续轮询；pending 需用户点「运行」才启动
      result.items
        .filter((r) => r.status === 'running')
        .forEach((r) => startPolling(r.id))
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '加载 A 股回测失败')
    } finally {
      loading.value = false
    }
  }

  async function loadDetail(id: string) {
    dailyLoading.value = true
    tradesLoading.value = true
    try {
      const [run, daily, trades] = await Promise.all([
        regimeBacktestApi.get(id),
        regimeBacktestApi.listDaily(id),
        regimeBacktestApi.listTrades(id),
      ])
      detailRun.value = run
      const ic = run.config?.capital?.initialCapital
      if (typeof ic === 'number' && Number.isFinite(ic) && ic > 0) {
        detailInitialCapital.value = ic
      }
      dailyRows.value = daily
      tradesRows.value = trades
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '加载详情失败')
    } finally {
      dailyLoading.value = false
      tradesLoading.value = false
    }
  }

  async function openDetail(id: string) {
    const run = runs.value.find((r) => r.id === id)
    showDetail.value = true
    detailRun.value = run ?? null
    dailyRows.value = []
    tradesRows.value = []
    await loadDetail(id)
  }

  function startPolling(id: string) {
    stopPolling(id)
    pollingIds.value = new Set(pollingIds.value).add(id)
    const timer = setInterval(async () => {
      try {
        const progress = await regimeBacktestApi.getProgress(id)
        const run = runs.value.find((r) => r.id === id)
        if (run) {
          run.status = progress.status
          run.phase = progress.phase
          run.progressDone = progress.progressDone
          run.progressTotal = progress.progressTotal
          run.errorMessage = progress.errorMessage
        }
        if (progress.status === 'completed' || progress.status === 'failed') {
          stopPolling(id)
          if (progress.status === 'completed') message.success('A 股回测完成')
          else message.error(progress.errorMessage ?? 'A 股回测失败')
          await loadList()
          if (detailRun.value?.id === id) await loadDetail(id)
        }
      } catch {
        stopPolling(id)
      }
    }, 2000)
    progressTimers.value.set(id, timer)
  }

  function stopPolling(id: string) {
    const t = progressTimers.value.get(id)
    if (t) {
      clearInterval(t)
      progressTimers.value.delete(id)
    }
    if (pollingIds.value.has(id)) {
      const next = new Set(pollingIds.value)
      next.delete(id)
      pollingIds.value = next
    }
  }

  async function openRun(id: string) {
    if (pollingIds.value.has(id) || getRunStatus(id) === 'running') {
      message.info('回测正在运行中')
      return
    }
    const local = runs.value.find((r) => r.id === id)
    if (local && !canRunStatus(local.status)) {
      message.warning(local.status === 'completed' ? '已完成的回测不可再运行' : '当前状态不可运行')
      return
    }
    try {
      await regimeBacktestApi.run(id)
      if (local) {
        local.status = 'running'
        local.phase = '启动中'
      }
      startPolling(id)
      message.success('已开始运行')
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '启动回测失败')
    }
  }

  async function openEdit(id: string) {
    try {
      const run = await regimeBacktestApi.get(id)
      if (!canEditStatus(run.status)) {
        message.warning('仅等待中或失败的方案可编辑')
        return
      }
      editingRunId.value = id
      showEditModal.value = true
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '加载方案失败')
    }
  }

  async function remove(id: string) {
    stopPolling(id)
    try {
      await regimeBacktestApi.remove(id)
      message.success('已删除')
      if (detailRun.value?.id === id) {
        detailRun.value = null
        showDetail.value = false
      }
      if (editingRunId.value === id) {
        editingRunId.value = null
        showEditModal.value = false
      }
      await loadList()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  /** 创建/编辑保存成功：只刷新列表，不自动跑 */
  function onCreateSuccess(_run: RegimeBacktestRun) {
    page.value = 1
    showEditModal.value = false
    editingRunId.value = null
  }

  function dispose() {
    progressTimers.value.forEach((t) => clearInterval(t))
    progressTimers.value.clear()
    pollingIds.value = new Set()
  }

  onUnmounted(dispose)

  return {
    runs,
    hubRows,
    total,
    loading,
    page,
    pageSize,
    showDetail,
    detailRun,
    detailInitialCapital,
    dailyRows,
    dailyLoading,
    tradesRows,
    tradesLoading,
    showEditModal,
    editingRunId,
    pollingIds,
    canRun,
    canEdit,
    loadList,
    openDetail,
    openRun,
    openEdit,
    remove,
    onCreateSuccess,
    dispose,
  }
}
