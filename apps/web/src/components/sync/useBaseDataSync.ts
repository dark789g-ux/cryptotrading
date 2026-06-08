import { computed, ref } from 'vue'
import { request } from '@/api/client'
import { useSSE } from '@/composables/hooks/useSSE'
import { baseDataSyncApi } from '@/api/modules/market/baseDataSync'

// 基础数据（trade_cal / stk_limit / suspend_d）同步 composable。
// 仿 useThsIndexDailySync 的标准 exports；后端契约（SSE / range）见
// docs/superpowers/specs/2026-06-08-base-data-sync-frontend-design/01-architecture.md

type SyncMode = 'incremental' | 'overwrite'

interface BaseDataRangePart {
  min: string | null
  max: string | null
}

interface BaseDataRange {
  stkLimit: BaseDataRangePart
  suspend: BaseDataRangePart
  tradeCal: BaseDataRangePart
}

interface BaseDataSyncErrorItem {
  apiName: string
  params: Record<string, string | number>
  message?: string
}

interface BaseDataSyncResult {
  success: number
  skipped: number
  errors: BaseDataSyncErrorItem[]
  // 预期正常的空日（仅 suspend_d 当日无停复牌），与后端 SyncResult.warnings 对齐；非失败。
  // 可选：后端实际恒返回该字段，但读取侧一律 `?? []` 防御，老测试 fixture 不必补该字段。
  warnings?: BaseDataSyncErrorItem[]
}

interface FinishedState {
  result: BaseDataSyncResult
}

// naive-ui n-date-picker 的 [number, number] 是本地午夜 ms，
// 提取/构造一律用本地 TZ（getFullYear/getMonth/getDate），否则 CST 用户日期整体漂前 1 天。
function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

// 'YYYYMMDD' → 本地午夜 ms。非法/空返回 null。
function parseYYYYMMDD(s: string | null): number | null {
  if (!s || s.length !== 8) return null
  const y = Number(s.slice(0, 4))
  const m = Number(s.slice(4, 6))
  const d = Number(s.slice(6, 8))
  if (!y || !m || !d) return null
  return new Date(y, m - 1, d).getTime()
}

function todayMidnight(): number {
  const now = new Date()
  return new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
}

function buildDefaultDateRange(): [number, number] {
  const end = todayMidnight()
  const start = end - 30 * 86400000
  return [start, end]
}

export function useBaseDataSync(message: {
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

  // 拉库存范围 → 标签显示 stk_limit 范围；增量模式据 stk_limit.max 提议默认起点。
  async function loadRange() {
    dateRangeLoading.value = true
    try {
      const range = await request<BaseDataRange>(baseDataSyncApi.rangeUrl())
      const stk = range.stkLimit
      if (!stk?.min || !stk?.max) {
        dateRangeLabel.value = 'stk_limit 暂无本地数据'
      } else {
        dateRangeLabel.value = `stk_limit ${stk.min}~${stk.max}`
      }

      // 仅增量模式据水位提议默认范围：[stk_limit.max + 1 天, 今日]。
      if (syncMode.value === 'incremental') {
        const maxTs = parseYYYYMMDD(stk?.max ?? null)
        if (maxTs !== null) {
          const start = maxTs + 86400000
          const end = todayMidnight()
          syncDateRange.value = [start, Math.max(start, end)]
        }
        // max 为 null（库存空）时保留 buildDefaultDateRange 的兜底窗口。
      }
    } catch {
      dateRangeLabel.value = 'stk_limit 读取失败'
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
    void loadRange()
  }

  async function confirmSync() {
    if (!syncDateRange.value) return
    syncing.value = true
    finished.value = null
    const url = baseDataSyncApi.syncRunUrl({
      start_date: toYYYYMMDD(syncDateRange.value[0]),
      end_date: toYYYYMMDD(syncDateRange.value[1]),
      syncMode: syncMode.value,
    })
    await sse.start(url, {
      method: 'GET',
      onDone: (data?: { result?: BaseDataSyncResult; message?: string }) => {
        if (data?.result) {
          finished.value = { result: data.result }
          const errCount = data.result.errors?.length ?? 0
          if (errCount) message.error(`同步完成，${errCount} 项失败`)
          else message.success('基础数据同步完成')
        }
        syncing.value = false
        void loadRange()
      },
      onError: (msg) => {
        message.error(msg)
        syncing.value = false
      },
    })
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
