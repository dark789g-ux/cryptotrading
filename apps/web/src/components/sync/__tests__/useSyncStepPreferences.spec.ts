import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useSyncStepPreferences } from '../useSyncStepPreferences'

vi.mock('@/api/modules/user-config/preferences', () => ({
  preferencesApi: {
    getSyncSteps: vi.fn(),
    saveSyncSteps: vi.fn(),
  },
}))

import { preferencesApi } from '@/api/modules/user-config/preferences'

const allKeys = ['a', 'b', 'c'] as const

describe('useSyncStepPreferences', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('默认全选初始化', () => {
    const { selectedStepKeys, allStepKeys } = useSyncStepPreferences({
      scope: 'ashare',
      allKeys,
    })
    expect(selectedStepKeys.value).toEqual(['a', 'b', 'c'])
    expect(allStepKeys.value).toEqual(['a', 'b', 'c'])
  })

  it('loadPreference() 成功加载，过滤未知 key', async () => {
    vi.mocked(preferencesApi.getSyncSteps).mockResolvedValue({ steps: ['a', 'c', 'unknown'] })

    const { selectedStepKeys, loadPreference } = useSyncStepPreferences({
      scope: 'ashare',
      allKeys,
    })
    await loadPreference()
    expect(selectedStepKeys.value).toEqual(['a', 'c'])
  })

  it('loadPreference() 失败时静默回退全选', async () => {
    vi.mocked(preferencesApi.getSyncSteps).mockRejectedValue(new Error('network'))

    const { selectedStepKeys, loadPreference } = useSyncStepPreferences({
      scope: 'ashare',
      allKeys,
    })
    await loadPreference()
    expect(selectedStepKeys.value).toEqual(['a', 'b', 'c'])
  })

  it('loadPreference() 返回空数组时 fallback 全选', async () => {
    vi.mocked(preferencesApi.getSyncSteps).mockResolvedValue({ steps: [] })

    const { selectedStepKeys, loadPreference } = useSyncStepPreferences({
      scope: 'ashare',
      allKeys,
    })
    await loadPreference()
    expect(selectedStepKeys.value).toEqual(['a', 'b', 'c'])
  })

  it('savePreference() 调用 API 传递当前选中', async () => {
    vi.mocked(preferencesApi.saveSyncSteps).mockResolvedValue({ ok: true })

    const { selectedStepKeys, savePreference } = useSyncStepPreferences({
      scope: 'ashare',
      allKeys,
    })
    selectedStepKeys.value = ['a']
    savePreference()

    await vi.waitFor(() => {
      expect(preferencesApi.saveSyncSteps).toHaveBeenCalledWith('ashare', { steps: ['a'] })
    })
  })

  it('toggleStep() 加入/移除 key', () => {
    const { selectedStepKeys, toggleStep } = useSyncStepPreferences({
      scope: 'ashare',
      allKeys,
    })

    toggleStep('b')
    expect(selectedStepKeys.value).toEqual(['a', 'c'])

    toggleStep('b')
    expect(selectedStepKeys.value).toEqual(['a', 'c', 'b'])
  })
})
