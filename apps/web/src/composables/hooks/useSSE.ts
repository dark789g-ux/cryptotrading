import { ref } from 'vue'
import { ApiError } from '../api/apiClient'
import { useAuth } from './useAuth'

export function useSSE() {
  const status = ref<'idle' | 'running' | 'done' | 'error'>('idle')
  const percent = ref(0)
  const phase = ref('')
  const message = ref('')
  const current = ref(0)
  const total = ref(0)

  let _abortCtrl: AbortController | null = null

  async function start(
    url: string,
    options: { method?: string; body?: unknown; onDone?: (data?: any) => void; onError?: (msg: string) => void } = {},
  ) {
    if (_abortCtrl) _abortCtrl.abort()
    _abortCtrl = new AbortController()

    status.value = 'running'
    percent.value = 0
    phase.value = '准备中'
    message.value = ''
    current.value = 0
    total.value = 0

    try {
      const auth = useAuth()
      if (!auth.ready.value) await auth.ensureLoaded()

      const fetchOptions: RequestInit = {
        method: options.method ?? 'GET',
        signal: _abortCtrl.signal,
        credentials: 'same-origin',
      }
      const headers = new Headers()
      let hasHeaders = false
      if (['POST', 'PUT', 'PATCH', 'DELETE'].includes(String(fetchOptions.method).toUpperCase())) {
        headers.set('X-Requested-With', 'XMLHttpRequest')
        hasHeaders = true
      }
      if (options.body) {
        headers.set('Content-Type', 'application/json')
        hasHeaders = true
        fetchOptions.body = JSON.stringify(options.body)
      }
      if (hasHeaders) fetchOptions.headers = headers

      const res = await fetch(url, fetchOptions)
      if (!res.ok) {
        const text = await res.text().catch(() => '')
        if (res.status === 401 && typeof window !== 'undefined') {
          window.dispatchEvent(new CustomEvent('api:unauthorized', { detail: { status: 401 } }))
        }
        throw new ApiError(res.status, res.status === 403 ? '没有权限执行此操作' : text || `HTTP ${res.status}`, text)
      }

      const reader = res.body!.getReader()
      const decoder = new TextDecoder()
      let buf = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += decoder.decode(value, { stream: true })
        const parts = buf.split('\n\n')
        buf = parts.pop() ?? ''
        for (const part of parts) {
          const line = part.trim()
          if (!line.startsWith('data:')) continue
          try {
            const data = JSON.parse(line.slice(5).trim())
            if (data.type === 'progress') {
              percent.value = data.percent ?? 0
              phase.value = data.phase ?? ''
              current.value = data.current ?? 0
              total.value = data.total ?? 0
              message.value = data.message ?? ''
            } else if (data.type === 'done') {
              status.value = 'done'
              percent.value = 100
              phase.value = '完成'
              message.value = data.message ?? '完成'
              options.onDone?.(data)
              return
            } else if (data.type === 'error') {
              status.value = 'error'
              message.value = data.message ?? '未知错误'
              options.onError?.(message.value)
              return
            }
          } catch { /* ignore JSON parse errors */ }
        }
      }
    } catch (err: unknown) {
      if (err instanceof Error && err.name === 'AbortError') return
      status.value = 'error'
      message.value = err instanceof Error ? err.message : '请求失败'
      options.onError?.(message.value)
    }
  }

  function reset() {
    if (_abortCtrl) { _abortCtrl.abort(); _abortCtrl = null }
    status.value = 'idle'
    percent.value = 0
    phase.value = ''
    message.value = ''
    current.value = 0
    total.value = 0
  }

  return { status, percent, phase, message, current, total, start, reset }
}
