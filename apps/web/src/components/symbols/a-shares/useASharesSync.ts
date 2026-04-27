import { computed, ref } from 'vue'
import { aSharesApi, type AShareDateRange, type AShareSyncMode, type AShareSyncResult } from '../../../composables/useApi'
import { useSSE } from '../../../composables/useSSE'
import { buildDefaultDateRange, formatDisplayDate, formatTradeDate, formatTushareDate } from './aSharesFormatters'

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
  const syncMode = ref<AShareSyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dataDateRange = ref<AShareDateRange | null>(null)
  const dataDateRangeLoading = ref(false)
  const dataDateRangeLoadFailed = ref(false)

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

  const dataDateRangeLabel = computed(() => {
    if (dataDateRangeLoading.value) return '读取中'
    if (dataDateRangeLoadFailed.value) return '读取失败'
    const range = dataDateRange.value
    if (!range?.min || !range.max) return '暂无本地数据'
    return `${formatTradeDate(range.min)} 至 ${formatTradeDate(range.max)}`
  })

  async function loadDataDateRange() {
    dataDateRangeLoading.value = true
    dataDateRangeLoadFailed.value = false
    try {
      dataDateRange.value = await aSharesApi.getDateRange()
    } catch {
      dataDateRangeLoadFailed.value = true
    } finally {
      dataDateRangeLoading.value = false
    }
  }

  function openSyncModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    if (!syncing.value) syncSse.reset()
    showSyncModal.value = true
    void loadDataDateRange()
  }

  async function syncAShares() {
    if (!syncDateRange.value) return
    syncing.value = true
    const [startMs, endMs] = syncDateRange.value
    const syncBody = {
      startDate: formatTushareDate(startMs),
      endDate: formatTushareDate(endMs),
      syncMode: syncMode.value,
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
      if (res.status === 'error') {
        message.error(buildSyncResultMessage(res, '同步未完成'))
      } else if (res.status === 'partial') {
        message.success(buildSyncResultMessage(res, '部分完成'))
      } else {
        message.success(buildSyncResultMessage(res, '同步完成'))
      }
    } else {
      message.success('同步完成')
    }
    try {
      showSyncModal.value = false
      await reload()
      await loadDataDateRange()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      syncing.value = false
    }
  }

  return {
    syncing,
    showSyncModal,
    syncMode,
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
    dataDateRangeLabel,
    dataDateRangeLoading,
    openSyncModal,
    syncAShares,
  }
}

function parseSyncResult(data: unknown): AShareSyncResult | null {
  if (!data || typeof data !== 'object') return null
  const value = data as Partial<AShareSyncResult>
  if (
    (value.status !== 'done' && value.status !== 'partial' && value.status !== 'error') ||
    typeof value.symbols !== 'number' ||
    typeof value.quotes !== 'number' ||
    typeof value.metrics !== 'number' ||
    typeof value.adjFactors !== 'number' ||
    typeof value.indicators !== 'number' ||
    typeof value.failedCount !== 'number' ||
    !Array.isArray(value.failedItems) ||
    typeof value.startDate !== 'string' ||
    typeof value.endDate !== 'string'
  ) {
    return null
  }
  return {
    ok: value.ok === true,
    status: value.status,
    symbols: value.symbols,
    quotes: value.quotes,
    metrics: value.metrics,
    adjFactors: value.adjFactors,
    indicators: value.indicators,
    failedCount: value.failedCount,
    failedItems: value.failedItems.filter(isSyncFailedItem),
    startDate: value.startDate,
    endDate: value.endDate,
    skippedDates: typeof value.skippedDates === 'number' ? value.skippedDates : undefined,
    skippedDatasets: typeof value.skippedDatasets === 'number' ? value.skippedDatasets : undefined,
  }
}

function isSyncFailedItem(value: unknown): value is { tradeDate?: string; apiName: string; message: string } {
  if (!value || typeof value !== 'object') return false
  const item = value as Partial<{ tradeDate?: string; apiName: string; message: string }>
  return (
    (item.tradeDate === undefined || typeof item.tradeDate === 'string') &&
    typeof item.apiName === 'string' &&
    typeof item.message === 'string'
  )
}

function buildSyncResultMessage(res: AShareSyncResult, title: string): string {
  const base = `${title}：标的 ${res.symbols}，日线 ${res.quotes}，每日指标 ${res.metrics}，复权因子 ${res.adjFactors}，技术指标 ${res.indicators}`
  if (res.failedCount <= 0) return base
  const firstFailure = res.failedItems[0]
  const detail = firstFailure
    ? `；失败 ${res.failedCount} 项，首项 ${firstFailure.tradeDate ? `${firstFailure.tradeDate} ` : ''}${firstFailure.apiName}`
    : `；失败 ${res.failedCount} 项`
  return `${base}${detail}`
}
