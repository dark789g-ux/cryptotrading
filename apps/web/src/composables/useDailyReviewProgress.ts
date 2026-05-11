import { ref, onUnmounted } from 'vue'
import type { ProgressEvent } from '@/types/daily-review'

export function useDailyReviewProgress(tradeDate: string) {
  const stage = ref<ProgressEvent['stage']>('validate')
  const percent = ref(0)
  const error = ref<string | null>(null)
  const done = ref(false)

  const es = new EventSource(`/api/daily-review/${tradeDate}/stream`, { withCredentials: true })
  es.onmessage = (ev) => {
    const e = JSON.parse(ev.data) as ProgressEvent
    stage.value = e.stage
    percent.value = e.percent
    if (e.stage === 'failed') error.value = (e as any).error
    if (e.stage === 'completed' || e.stage === 'failed') {
      done.value = true
      es.close()
    }
  }
  es.onerror = () => {
    es.close()
    error.value = error.value ?? '连接断开'
    done.value = true
  }

  onUnmounted(() => es.close())

  return { stage, percent, error, done }
}
