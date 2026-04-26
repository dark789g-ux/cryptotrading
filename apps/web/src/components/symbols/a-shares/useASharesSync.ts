import { computed, ref } from 'vue'
import { aSharesApi, type AShareSyncResult } from '../../../composables/useApi'
import { useSSE } from '../../../composables/useSSE'
import { buildDefaultDateRange, formatDisplayDate, formatTushareDate } from './aSharesFormatters'

export function useASharesSync(
  message: {
    error: (content: string) => void
    success: (content: string) => void
  },
  reload: () => Promise<void>,
) {
  const syncSse = useSSE()
  const syncing = ref(false)
  const showSyncModal = ref(false)
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())

  const syncProgressVisible = computed(() => syncSse.status.value !== 'idle')
  const syncStatusLabel = computed(() => {
    if (syncSse.status.value === 'done') return '同步完成'
    if (syncSse.status.value === 'error') return '同步失败'
    if (syncSse.status.value === 'running') return '同步中'
    return '等待同步'
  })
  const syncProgressCountLabel = computed(() => {
    const current = syncSse.current.value
    const total = syncSse.total.value
    if (!total) return ''
    return `${current}/${total} 个交易日`
  })

  const canConfirmSync = computed(() => {
    const range = syncDateRange.value
    return Boolean(range && range[0] && range[1])
  })

  const syncRangeLabel = computed(() => {
    const range = syncDateRange.value
    return {
      start: range ? formatDisplayDate(range[0]) : '未选择',
      end: range ? formatDisplayDate(range[1]) : '未选择',
    }
  })

  function openSyncModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    if (!syncing.value) syncSse.reset()
    showSyncModal.value = true
  }

  async function syncAShares() {
    if (!syncDateRange.value) return
    syncing.value = true
    const [startMs, endMs] = syncDateRange.value
    const syncBody = {
      startDate: formatTushareDate(startMs),
      endDate: formatTushareDate(endMs),
    }
    await syncSse.start(aSharesApi.syncRunUrl(syncBody), {
      method: 'GET',
      onDone: (data: unknown) => {
        void finishSyncAShares(data)
      },
      onError: (msg) => {
        syncing.value = false
        message.error(msg)
      },
    })
  }

  async function finishSyncAShares(data: unknown) {
    const res = parseSyncResult(data)
    if (res) {
      message.success(`同步完成：标的 ${res.symbols}，日线 ${res.quotes}，每日指标 ${res.metrics}，技术指标 ${res.indicators}`)
    } else {
      message.success('同步完成')
    }
    try {
      showSyncModal.value = false
      await reload()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      syncing.value = false
    }
  }

  return {
    syncing,
    showSyncModal,
    syncDateRange,
    syncProgressVisible,
    syncStatusLabel,
    syncProgressCountLabel,
    canConfirmSync,
    syncRangeLabel,
    syncPhase: syncSse.phase,
    syncPercent: syncSse.percent,
    syncStatus: syncSse.status,
    syncMessage: syncSse.message,
    openSyncModal,
    syncAShares,
  }
}

function parseSyncResult(data: unknown): AShareSyncResult | null {
  if (!data || typeof data !== 'object') return null
  const value = data as Partial<AShareSyncResult>
  if (
    typeof value.symbols !== 'number' ||
    typeof value.quotes !== 'number' ||
    typeof value.metrics !== 'number' ||
    typeof value.indicators !== 'number' ||
    typeof value.startDate !== 'string' ||
    typeof value.endDate !== 'string'
  ) {
    return null
  }
  return {
    ok: value.ok === true,
    symbols: value.symbols,
    quotes: value.quotes,
    metrics: value.metrics,
    indicators: value.indicators,
    startDate: value.startDate,
    endDate: value.endDate,
  }
}
