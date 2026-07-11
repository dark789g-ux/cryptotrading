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

  const progressTimers = ref<Map<string, ReturnType<typeof setInterval>>>(new Map())
  const hubRows = computed(() => runs.value.map(toAshareHubRow))

  async function loadList(filter?: { status?: string; keyword?: string }) {
    loading.value = true
    try {
      const result = await regimeBacktestApi.list(page.value, pageSize.value, {
        status: filter?.status || undefined,
        keyword: filter?.keyword || undefined,
      })
      runs.value = result.items
      total.value = result.total
      result.items
        .filter((r) => r.status === 'running' || r.status === 'pending')
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
      await loadList()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : '删除失败')
    }
  }

  function onCreateSuccess(run: RegimeBacktestRun) {
    startPolling(run.id)
    page.value = 1
  }

  function dispose() {
    progressTimers.value.forEach((t) => clearInterval(t))
    progressTimers.value.clear()
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
    loadList,
    openDetail,
    remove,
    onCreateSuccess,
    dispose,
  }
}
