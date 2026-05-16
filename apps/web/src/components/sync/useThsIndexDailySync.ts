import { computed, ref } from 'vue'
import { API_BASE, request } from '@/api/client'
import { useSSE } from '@/composables/hooks/useSSE'

interface ThsIndexDailyDateRange {
  min: string | null
  max: string | null
}

type SyncMode = 'incremental' | 'overwrite'

interface ThsIndexDailySyncErrorItem {
  apiName: string
  params: Record<string, string | number>
  message?: string
}

interface ThsIndexDailySyncResult {
  success: number
  skipped: number
  errors: ThsIndexDailySyncErrorItem[]
}

interface FinishedState {
  result: ThsIndexDailySyncResult
}

function buildDefaultDateRange(): [number, number] {
  // 默认 30 天窗口；用户从日期选择器选的"日历日"用本地 TZ 提取
  const end = Date.now()
  const start = end - 30 * 86400000
  return [start, end]
}

// naive-ui n-date-picker 返回的是本地午夜 ms，用本地 TZ 提取年月日。
function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function formatDateLabel(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '暂无本地数据'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

export function useThsIndexDailySync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const sse = useSSE()
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<SyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dateRangeLabel = ref('读取中...')
  const dateRangeLoading = ref(false)
  const finished = ref<FinishedState | null>(null)

  async function loadDateRange() {
    dateRangeLoading.value = true
    try {
      const range = await request<ThsIndexDailyDateRange>(`${API_BASE}/ths-index-daily/date-range`)
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

  const canConfirm = computed(() => {
    const r = syncDateRange.value
    return Boolean(r && r[0] && r[1]) && !syncing.value && !finished.value
  })

  const syncProgressVisible = computed(
    () => sse.status.value !== 'idle' || finished.value !== null,
  )

  function openModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    if (!syncing.value) {
      sse.reset()
      finished.value = null
    }
    show.value = true
    void loadDateRange()
  }

  async function confirmSync() {
    if (!syncDateRange.value) return
    syncing.value = true
    finished.value = null
    const qs = new URLSearchParams({
      start_date: toYYYYMMDD(syncDateRange.value[0]),
      end_date: toYYYYMMDD(syncDateRange.value[1]),
      syncMode: syncMode.value,
    })
    await sse.start(
      `${API_BASE}/ths-index-daily/sync/run?${qs.toString()}`,
      {
        method: 'GET',
        onDone: (data?: { result?: ThsIndexDailySyncResult; message?: string }) => {
          if (data?.result) {
            finished.value = { result: data.result }
            const errCount = data.result.errors?.length ?? 0
            if (errCount) message.error(`同步完成，${errCount} 项失败（含 ths_daily_empty）`)
            else message.success('指数日线同步完成')
          }
          syncing.value = false
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
    finished,
    openModal,
    confirmSync,
  }
}
