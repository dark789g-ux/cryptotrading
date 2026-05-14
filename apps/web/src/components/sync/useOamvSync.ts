import { computed, ref } from 'vue'
import { oamvApi } from '@/api/modules/market/oamv'

type SyncMode = 'incremental' | 'overwrite'

function buildDefaultDateRange(): [number, number] {
  const end = Date.now()
  const start = end - 60 * 86400000
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

export function useOamvSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<SyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())
  const dateRangeLabel = ref('读取中...')
  const dateRangeLoading = ref(false)

  const canConfirm = computed(() => {
    const r = syncDateRange.value
    return Boolean(r && r[0] && r[1]) && !syncing.value
  })

  async function loadDateRange() {
    dateRangeLoading.value = true
    try {
      const range = await oamvApi.getDateRange()
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
    try {
      const result = await oamvApi.sync({
        startDate: toYYYYMMDD(syncDateRange.value[0]),
        endDate: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      })
      message.success(`0AMV 同步完成，共 ${result.synced} 条数据`)
      show.value = false
      void loadDateRange()
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '0AMV 同步失败')
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
    openModal,
    confirmSync,
  }
}
