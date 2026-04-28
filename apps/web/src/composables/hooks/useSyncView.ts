import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import { useMessage } from 'naive-ui'
import { syncApi, symbolApi } from '@/api'
import { useSSE } from './useSSE'

export type SyncLogEntry = { type: string; message: string; time: string }

export function useSyncView() {
  const message = useMessage()
  const sse = useSSE()

  const syncConfig = ref({ symbols: [] as string[], intervals: ['1h'] as string[] })
  const symbolMode = ref<'all' | 'custom'>('all')
  const symbolOptions = ref<{ label: string; value: string }[]>([])
  const loadingSymbols = ref(false)
  const saving = ref(false)
  const logs = ref<SyncLogEntry[]>([])
  const logRef = ref<HTMLElement | null>(null)
  const overview = ref({ intervals: ['1h'], symbolCount: 0, lastSync: '' })

  const statusText = computed(
    () =>
      ({
        idle: '等待同步',
        running: '同步进行中',
        done: '同步完成',
        error: '同步失败',
      }[sse.status.value] || '未知'),
  )

  const addLog = (type: string, msg: string) => {
    logs.value.push({ type, message: msg, time: new Date().toLocaleTimeString() })
    nextTick(() => {
      if (logRef.value) logRef.value.scrollTop = logRef.value.scrollHeight
    })
  }

  const loadConfig = async () => {
    try {
      const prefs = await syncApi.getPreferences()
      syncConfig.value = { symbols: prefs.symbols || [], intervals: prefs.intervals || ['1h'] }
      symbolMode.value = prefs.symbols?.length ? 'custom' : 'all'
      overview.value.intervals = syncConfig.value.intervals
    } catch (err) {
      console.error('加载配置失败:', err)
    }
  }

  const loadSymbols = async () => {
    loadingSymbols.value = true
    try {
      const names = await symbolApi.getNames('1d')
      symbolOptions.value = names.map((s) => ({ label: s, value: s }))
      overview.value.symbolCount = symbolMode.value === 'all' ? names.length : syncConfig.value.symbols.length
    } finally {
      loadingSymbols.value = false
    }
  }

  const saveConfig = async () => {
    saving.value = true
    try {
      await syncApi.savePreferences({
        intervals: syncConfig.value.intervals,
        symbols: symbolMode.value === 'custom' ? syncConfig.value.symbols : [],
      })
      message.success('配置已保存')
      overview.value.intervals = syncConfig.value.intervals
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err)
      message.error(msg)
    } finally {
      saving.value = false
    }
  }

  const startSync = async () => {
    await saveConfig()
    logs.value = []
    addLog('info', '开始数据同步...')
    sse.start('/api/sync/run', {
      method: 'GET',
      onDone: () => {
        overview.value.lastSync = new Date().toLocaleString()
        addLog('success', '数据同步完成')
        message.success('同步完成')
      },
      onError: (msg) => {
        addLog('error', msg)
        message.error(msg)
      },
    })

    const stopWatch = watch([sse.phase, sse.current], ([ph, cur]) => {
      if (ph && cur > 0 && sse.status.value === 'running') {
        addLog('info', `${ph}: ${sse.current.value}/${sse.total.value}`)
      }
    })
    watch(sse.status, (s) => {
      if (s !== 'running') stopWatch()
    })
  }

  watch(symbolMode, (val) => {
    overview.value.symbolCount = val === 'all' ? symbolOptions.value.length : syncConfig.value.symbols.length
  })

  onMounted(() => {
    void loadConfig()
    void loadSymbols()
  })
  onUnmounted(() => sse.reset())

  return {
    sse,
    syncConfig,
    symbolMode,
    symbolOptions,
    loadingSymbols,
    saving,
    logs,
    logRef,
    overview,
    statusText,
    saveConfig,
    startSync,
  }
}
