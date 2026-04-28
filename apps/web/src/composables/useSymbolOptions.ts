import { ref, computed } from 'vue'
import { useMessage } from 'naive-ui'
import { symbolApi } from '@/api'

const SELECT_ALL = '__SELECT_ALL__'

export function useSymbolOptions() {
  const message = useMessage()

  const symbolOptions = ref<{ label: string; value: string }[]>([])
  const loadingSymbols = ref(false)

  const symbolOptionsWithAll = computed(() => [
    { label: '全选所有标的', value: SELECT_ALL },
    ...symbolOptions.value,
  ])

  const isSelectAll = (vals: string[]) => vals.includes(SELECT_ALL)

  const loadSymbolOptions = async (timeframe: string) => {
    loadingSymbols.value = true
    try {
      const names = await symbolApi.getNames(timeframe)
      symbolOptions.value = names.map((s: string) => ({ label: s, value: s }))
    } catch (err: unknown) {
      message.error((err as Error).message || '加载标的失败')
    } finally {
      loadingSymbols.value = false
    }
  }

  return {
    symbolOptions,
    loadingSymbols,
    symbolOptionsWithAll,
    loadSymbolOptions,
    isSelectAll,
    allSymbolValues: () => symbolOptions.value.map((o) => o.value),
  }
}
