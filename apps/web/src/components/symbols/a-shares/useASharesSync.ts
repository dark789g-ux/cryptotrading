import { ref } from 'vue'
import { aSharesApi, type AShareSyncMode, type AShareSyncResult } from '@/api'
import { useSSE } from '../../../composables/hooks/useSSE'
import { buildDefaultDateRange, formatTushareDate } from './aSharesFormatters'

export function useASharesSync(
  message: {
    error: (content: string) => void
    success: (content: string) => void
  },
  reload: () => Promise<void>,
) {
  const syncSse = useSSE()
  const syncing = ref(false)
  const syncMode = ref<AShareSyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())

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
      await reload()
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    } finally {
      syncing.value = false
    }
  }

  return {
    syncing,
    syncMode,
    syncDateRange,
    syncPhase: syncSse.phase,
    syncPercent: syncSse.percent,
    syncStatus: syncSse.status,
    syncMessage: syncSse.message,
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
