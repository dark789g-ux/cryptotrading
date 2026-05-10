import { computed, ref } from 'vue'
import { moneyFlowApi } from '@/api/modules/moneyFlow'
import type { MoneyFlowSyncResult } from '@/api/modules/moneyFlow'

type SyncMode = 'incremental' | 'overwrite'

function buildDefaultDateRange(): [number, number] {
  const end = Date.now()
  const start = end - 30 * 86400000
  return [start, end]
}

function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

function formatDateLabel(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '暂无本地数据'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

export function useMoneyFlowSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<SyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dateRangeLabel = ref('读取中...')
  const dateRangeLoading = ref(false)
  const lastResult = ref<{
    stocks: MoneyFlowSyncResult
    industries: MoneyFlowSyncResult
    sectors: MoneyFlowSyncResult
    market: MoneyFlowSyncResult
  } | null>(null)

  const canConfirm = computed(() => {
    const r = syncDateRange.value
    return Boolean(r && r[0] && r[1]) && !syncing.value
  })

  async function loadDateRange() {
    dateRangeLoading.value = true
    try {
      const range = await moneyFlowApi.getDateRange()
      if (!range.min || !range.max) {
        dateRangeLabel.value = '暂无本地数据'
      } else {
        dateRangeLabel.value = `${formatDateLabel(range.min)} 至 ${formatDateLabel(range.max)}`
      }
    } catch {
      dateRangeLabel.value = '读取失败'
    } finally {
      dateRangeLoading.value = false
    }
  }

  function openModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    show.value = true
    void loadDateRange()
  }

  async function confirmSync() {
    if (!syncDateRange.value) return
    syncing.value = true
    const params = {
      start_date: toYYYYMMDD(syncDateRange.value[0]),
      end_date: toYYYYMMDD(syncDateRange.value[1]),
      syncMode: syncMode.value,
    }
    try {
      const [stocks, industries, sectors, market] = await Promise.all([
        moneyFlowApi.syncStocks(params),
        moneyFlowApi.syncIndustries(params),
        moneyFlowApi.syncSectors(params),
        moneyFlowApi.syncMarket(params),
      ])
      lastResult.value = { stocks, industries, sectors, market }
      message.success(`同步完成：个股 ${stocks.success} 条`)
      show.value = false
      void loadDateRange()
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '同步失败')
    } finally {
      syncing.value = false
    }
  }

  return {
    show,
    syncing,
    syncMode,
    syncDateRange,
    dateRangeLabel,
    dateRangeLoading,
    canConfirm,
    lastResult,
    openModal,
    confirmSync,
  }
}
