import { computed, ref } from 'vue'
import { preferencesApi } from '@/api/modules/user-config/preferences'

export interface SyncStepPreferencesOptions {
  scope: 'ashare' | 'us'
  allKeys: readonly string[]
}

export function useSyncStepPreferences(options: SyncStepPreferencesOptions) {
  const { scope, allKeys } = options

  const selectedStepKeys = ref<string[]>([...allKeys])
  const allStepKeys = computed<readonly string[]>(() => allKeys)

  async function loadPreference(): Promise<void> {
    try {
      const { steps } = await preferencesApi.getSyncSteps(scope)
      const knownSet = new Set(allKeys)
      const valid = steps.filter(k => knownSet.has(k))
      selectedStepKeys.value = valid.length > 0 ? valid : [...allKeys]
    } catch {
      // 静默失败：保持默认全选
    }
  }

  function savePreference(): void {
    preferencesApi.saveSyncSteps(scope, { steps: selectedStepKeys.value }).catch(() => {})
  }

  function toggleStep(key: string): void {
    const i = selectedStepKeys.value.indexOf(key)
    if (i >= 0) selectedStepKeys.value = selectedStepKeys.value.filter(k => k !== key)
    else selectedStepKeys.value = [...selectedStepKeys.value, key]
  }

  return {
    selectedStepKeys,
    allStepKeys,
    loadPreference,
    savePreference,
    toggleStep,
  }
}
