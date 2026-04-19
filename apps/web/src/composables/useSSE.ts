import { ref } from 'vue'

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
      const fetchOptions: RequestInit = {
        method: options.method ?? 'GET',
        signal: _abortCtrl.signal,
      }
      if (options.body) {
        fetchOptions.headers = { 'Content-Type': 'application/json' }
        fetchOptions.body = JSON.stringify(options.body)
      }

      const res = await fetch(url, fetchOptions)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)

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
    } catch (err: any) {
      if (err.name === 'AbortError') return
      status.value = 'error'
      message.value = err.message
      options.onError?.(err.message)
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
