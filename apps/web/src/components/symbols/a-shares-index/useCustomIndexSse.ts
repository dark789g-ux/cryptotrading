import { onBeforeUnmount, ref } from 'vue'
import {
  customIndexApi,
  type CustomIndexSseProgressEvent,
  type CustomIndexStatus,
} from '@/api/modules/market/customIndex'

const TERMINAL: CustomIndexStatus[] = ['ready', 'failed']

export function useCustomIndexSse(onUpdate: (event: CustomIndexSseProgressEvent) => void) {
  const connecting = ref(false)
  let es: EventSource | null = null
  let activeId: string | null = null

  function close() {
    es?.close()
    es = null
    activeId = null
    connecting.value = false
  }

  async function subscribe(indexId: string) {
    if (activeId === indexId && es) return
    close()
    connecting.value = true
    activeId = indexId
    try {
      const { token } = await customIndexApi.issueSseToken(indexId)
      es = new EventSource(customIndexApi.buildSseUrl(indexId, token))
      es.onmessage = (ev) => {
        try {
          const data = JSON.parse(ev.data) as CustomIndexSseProgressEvent
          onUpdate(data)
          if (TERMINAL.includes(data.status)) close()
        } catch {
          /* ignore malformed */
        }
      }
      es.onerror = () => {
        close()
      }
    } catch {
      close()
    }
  }

  onBeforeUnmount(close)

  return { subscribe, close, connecting }
}
