import { computed, ref } from 'vue'
import { indexCatalogApi } from '@/api/modules/indexCatalog'
import type { IndexCatalogSyncSummary, MoneyFlowSyncResult } from '@cryptotrading/shared-types'
import { useSSE } from '@/composables/hooks/useSSE'

interface FinishedState {
  summary: IndexCatalogSyncSummary
  errors: Array<{ phase: string; error: string }>
}

const PHASE_LABEL_MAP: Record<keyof IndexCatalogSyncSummary, string> = {
  industryCatalog: '行业目录',
  conceptCatalog: '概念目录',
  industryMembers: '行业成员',
  conceptMembers: '概念成员',
  cleanup: '清理',
}

export function useIndexCatalogSync(message: {
  error: (msg: string) => void
  success: (msg: string) => void
}) {
  const sse = useSSE()
  const show = ref(false)
  const syncing = ref(false)
  const finished = ref<FinishedState | null>(null)

  const syncProgressVisible = computed(
    () => sse.status.value !== 'idle' || finished.value !== null,
  )

  function openModal() {
    if (!syncing.value) {
      sse.reset()
      finished.value = null
    }
    show.value = true
  }

  async function confirmSync() {
    syncing.value = true
    finished.value = null
    await sse.start(
      indexCatalogApi.syncRunUrl(),
      {
        method: 'GET',
        onDone: (data?: { summary?: IndexCatalogSyncSummary; message?: string }) => {
          if (data?.summary) {
            const errs = (
              Object.entries(data.summary) as Array<[keyof IndexCatalogSyncSummary, MoneyFlowSyncResult]>
            ).flatMap(([key, r]) =>
              (r?.errors ?? []).map(error => ({ phase: PHASE_LABEL_MAP[key], error })),
            )
            finished.value = { summary: data.summary, errors: errs }
            if (errs.length) message.error(`同步完成，${errs.length} 个阶段失败`)
            else message.success('指数目录同步完成')
          }
          syncing.value = false
        },
        onError: (msg) => {
          message.error(msg)
          syncing.value = false
        },
      },
    )
  }

  function stop() {
    sse.reset()
    syncing.value = false
  }

  return {
    show,
    syncing,
    syncProgressVisible,
    sse,
    finished,
    openModal,
    confirmSync,
    stop,
  }
}
