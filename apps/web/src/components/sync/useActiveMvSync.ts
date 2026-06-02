import { computed, ref } from 'vue'
import { activeMvApi, type AmvSyncResult } from '@/api/modules/market/active-mv'

type SyncMode = 'incremental' | 'overwrite'

function buildDefaultDateRange(): [number, number] {
  // 本地午夜 ms（遵循 datetime.md 日期选择器例外，禁用 getUTC*）
  const now = new Date()
  const end = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime()
  const start = end - 60 * 86400000
  return [start, end]
}

// 用户从日期选择器选的"日历日"用本地 TZ 提取——naive-ui n-date-picker 返回本地午夜 ms，
// 用 UTC 方法会把 CST 用户选的日期整体推前 1 天。
function toYYYYMMDD(ts: number): string {
  const d = new Date(ts)
  return `${d.getFullYear()}${String(d.getMonth() + 1).padStart(2, '0')}${String(d.getDate()).padStart(2, '0')}`
}

/**
 * 活跃市值（AMV）同步 composable——封装个股 / 行业 / 概念三类普通 POST 同步。
 *
 * 镜像 useOamvSync 结构，但 AMV 端点无 getDateRange，故不含 dateRangeLabel 逻辑。
 * 一键同步与各自页面手动同步均可复用：三个方法均为普通 POST + await，
 * 由调用方决定 syncMode（一键同步一律 incremental，避免全量回填撞网关 timeout）。
 */
export function useActiveMvSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const show = ref(false)
  const syncing = ref(false)
  const syncMode = ref<SyncMode>('incremental')
  const syncDateRange = ref<[number, number] | null>(buildDefaultDateRange())

  const canConfirm = computed(() => {
    const r = syncDateRange.value
    return Boolean(r && r[0] && r[1]) && !syncing.value
  })

  function openModal() {
    if (!syncDateRange.value) syncDateRange.value = buildDefaultDateRange()
    show.value = true
  }

  async function syncStock(): Promise<AmvSyncResult | null> {
    if (!syncDateRange.value) return null
    syncing.value = true
    try {
      const result = await activeMvApi.syncStock({
        startDate: toYYYYMMDD(syncDateRange.value[0]),
        endDate: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      })
      message.success(`个股 AMV 同步完成，共 ${result.synced} 条数据`)
      return result
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '个股 AMV 同步失败')
      throw e
    } finally {
      syncing.value = false
    }
  }

  async function syncIndustry(): Promise<AmvSyncResult | null> {
    if (!syncDateRange.value) return null
    syncing.value = true
    try {
      const result = await activeMvApi.syncIndustry({
        startDate: toYYYYMMDD(syncDateRange.value[0]),
        endDate: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      })
      message.success(`行业指数 AMV 同步完成，共 ${result.synced} 条数据`)
      return result
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '行业指数 AMV 同步失败')
      throw e
    } finally {
      syncing.value = false
    }
  }

  async function syncConcept(): Promise<AmvSyncResult | null> {
    if (!syncDateRange.value) return null
    syncing.value = true
    try {
      const result = await activeMvApi.syncConcept({
        startDate: toYYYYMMDD(syncDateRange.value[0]),
        endDate: toYYYYMMDD(syncDateRange.value[1]),
        syncMode: syncMode.value,
      })
      message.success(`板块（概念）AMV 同步完成，共 ${result.synced} 条数据`)
      return result
    } catch (e: unknown) {
      message.error(e instanceof Error ? e.message : '板块（概念）AMV 同步失败')
      throw e
    } finally {
      syncing.value = false
    }
  }

  return {
    show,
    syncing,
    syncMode,
    syncDateRange,
    canConfirm,
    openModal,
    syncStock,
    syncIndustry,
    syncConcept,
  }
}
