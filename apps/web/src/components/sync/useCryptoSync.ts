import { computed, ref } from 'vue'
import { syncApi } from '@/api/modules/sync'
import type { CryptoSyncMode } from '@/api/modules/sync'
import { useSSE } from '@/composables/hooks/useSSE'

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

export function useCryptoSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const sse = useSSE()
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<CryptoSyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dateRangeLabel = ref('读取中...')
  const dateRangeLoading = ref(false)

  const canConfirm = computed(
    () => Boolean(syncDateRange.value?.[0] && syncDateRange.value?.[1]) && !syncing.value,
  )
  const syncProgressVisible = computed(() => sse.status.value !== 'idle')

  async function loadDateRange() {
    dateRangeLoading.value = true
    try {
      const range = await syncApi.getDateRange()
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
    if (!syncing.value) sse.reset()
    show.value = true
    void loadDateRange()
  }

  async function confirmSync() {
    if (!syncDateRange.value) return
    syncing.value = true
    await sse.start(
      syncApi.syncRunUrl({
        startDate: toYYYYMMDD(syncDateRange.value[0]),
        endDate: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      }),
      {
        method: 'GET',
        onDone: () => {
          message.success('加密货币数据同步完成')
          syncing.value = false
          show.value = false
          void loadDateRange()
        },
        onError: (msg) => {
          message.error(msg)
          syncing.value = false
        },
      },
    )
  }

  return {
    show,
    syncing,
    syncMode,
    syncDateRange,
    dateRangeLabel,
    dateRangeLoading,
    canConfirm,
    syncProgressVisible,
    sse,
    openModal,
    confirmSync,
  }
}
