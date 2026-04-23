import { ref, computed } from 'vue'
import { useMessage } from 'naive-ui'
import { strategyApi } from '../useApi'
import type { StrategyFormData } from './useStrategyForm'

export function useImportStrategies(propsRef: { strategy?: unknown }) {
  const message = useMessage()

  const importStrategyId = ref<string | null>(null)
  const importStrategyOptions = ref<{ label: string; value: string }[]>([])
  const loadingImportStrategies = ref(false)
  let importStrategiesLoaded = false

  const showImportPopover = ref(false)
  const importSearchText = ref('')

  const filteredImportOptions = computed(() => {
    if (!importSearchText.value) return importStrategyOptions.value
    const lower = importSearchText.value.toLowerCase()
    return importStrategyOptions.value.filter((o) => o.label.toLowerCase().includes(lower))
  })

  const resetImportState = () => {
    importStrategiesLoaded = false
    importStrategyId.value = null
    importSearchText.value = ''
  }

  const handlePopoverShow = (show: boolean) => {
    if (show) {
      loadImportStrategies()
    } else {
      importSearchText.value = ''
    }
  }

  const loadImportStrategies = async () => {
    if (importStrategiesLoaded) return
    loadingImportStrategies.value = true
    try {
      const res = await strategyApi.getStrategies()
      const selfId = (propsRef.strategy as Record<string, unknown>)?.id
      importStrategyOptions.value = (res.rows as Record<string, unknown>[])
        .filter((s) => s.id !== selfId)
        .map((s) => ({ label: s.name as string, value: s.id as string }))
      importStrategiesLoaded = true
    } catch (err: unknown) {
      message.error((err as Error).message || '加载策略列表失败')
    } finally {
      loadingImportStrategies.value = false
    }
  }

  const handleImportStrategy = async (
    id: string | null,
    callbacks: {
      onSuccess: (data: StrategyFormData) => void
      onClose: () => void
    }
  ) => {
    if (!id) return
    try {
      const s = await strategyApi.getStrategy(id)
      const imported: StrategyFormData = {
        name: (s?.name as string) ?? '',
        typeId: (s?.typeId as string) ?? 'ma_kdj',
        symbols: ((s?.symbols as string[]) ?? []),
        params: { ...(s?.params as StrategyFormData['params']) },
      }
      callbacks.onSuccess(imported)
      message.success('参数已导入')
      callbacks.onClose()
    } catch (err: unknown) {
      message.error((err as Error).message || '导入失败')
    } finally {
      importStrategyId.value = null
    }
  }

  return {
    showImportPopover,
    importSearchText,
    loadingImportStrategies,
    filteredImportOptions,
    handlePopoverShow,
    handleImportStrategy,
    resetImportState,
  }
}
