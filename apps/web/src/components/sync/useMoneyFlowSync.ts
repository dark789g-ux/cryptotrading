import { computed, ref } from 'vue'
import { moneyFlowApi } from '@/api/modules/market/moneyFlow'
import type { MoneyFlowSyncSummary, MoneyFlowSyncResult } from '@/api/modules/market/moneyFlow'
import { useSSE } from '@/composables/hooks/useSSE'

type SyncMode = 'incremental' | 'overwrite'

interface FinishedState {
  summary: MoneyFlowSyncSummary
  errors: Array<{ phase: string; error: string }>
}

function buildDefaultDateRange(): [number, number] {
  const end = Date.now()
  const start = end - 30 * 86400000
  return [start, end]
}

// 用户从日期选择器选的"日历日"用本地 TZ 提取——naive-ui n-date-picker 返回的是本地午夜 ms，
// 用 UTC 方法会把 CST 用户选的日期整体推前 1 天。
function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

function formatDateLabel(yyyymmdd: string | null): string {
  if (!yyyymmdd) return '暂无本地数据'
  return `${yyyymmdd.slice(0, 4)}-${yyyymmdd.slice(4, 6)}-${yyyymmdd.slice(6, 8)}`
}

const PHASE_LABEL_MAP: Record<keyof MoneyFlowSyncSummary, string> = {
  stocks: '个股',
  industries: '行业',
  sectors: '板块',
  market: '大盘',
}

export function useMoneyFlowSync(message: {
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

  const canConfirm = computed(() => {
    const r = syncDateRange.value
    return Boolean(r && r[0] && r[1]) && !syncing.value && !finished.value
  })

  const syncProgressVisible = computed(
    () => sse.status.value !== 'idle' || finished.value !== null,
  )

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
    await sse.start(
      moneyFlowApi.syncRunUrl({
        start_date: toYYYYMMDD(syncDateRange.value[0]),
        end_date: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      }),
      {
        method: 'GET',
        onDone: (data?: { summary?: MoneyFlowSyncSummary; message?: string }) => {
          if (data?.summary) {
            const errs = (Object.entries(data.summary) as Array<[keyof MoneyFlowSyncSummary, MoneyFlowSyncResult]>)
              .flatMap(([key, r]) =>
                (r?.errors ?? []).map(error => ({ phase: PHASE_LABEL_MAP[key], error })),
              )
            finished.value = { summary: data.summary, errors: errs }
            if (errs.length) message.error(`同步完成，${errs.length} 个交易日失败`)
            else message.success('资金流向同步完成')
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
