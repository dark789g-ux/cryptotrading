import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { defineComponent, h, nextTick } from 'vue'
import { mount } from '@vue/test-utils'
import { useKlineChartPrefs, _resetMigratedKeys } from './useKlineChartPrefs'
import { DEFAULT_KDJ_PARAMS, type SubplotKey } from './subplotConfig'
import type { KlinePrefsPayload } from '@/api/modules/user-config/preferences'

// Mock the preferencesApi module
const mockGetKlinePrefs = vi.fn<(prefsKey: string) => Promise<KlinePrefsPayload | null>>()
const mockSaveKlinePrefs = vi.fn<(prefsKey: string, body: KlinePrefsPayload) => Promise<{ ok: true }>>()

vi.mock('@/api/modules/user-config/preferences', () => ({
  preferencesApi: {
    getKlinePrefs: (...args: unknown[]) => mockGetKlinePrefs(...(args as [string])),
    saveKlinePrefs: (...args: unknown[]) => mockSaveKlinePrefs(...(args as [string, KlinePrefsPayload])),
  },
}))

describe('useKlineChartPrefs — params 持久化', () => {
  let storage: Record<string, string> = {}
  const available: readonly SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']

  beforeEach(() => {
    storage = {}
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          delete storage[key]
        }),
        clear: vi.fn(() => {
          Object.keys(storage).forEach((k) => delete storage[k])
        }),
      },
      writable: true,
    })
    vi.useFakeTimers()
    mockGetKlinePrefs.mockClear()
    mockGetKlinePrefs.mockResolvedValue({ order: [] })
    mockSaveKlinePrefs.mockClear()
    mockSaveKlinePrefs.mockResolvedValue({ ok: true })
    _resetMigratedKeys()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function storedFor(key: string): Record<string, unknown> | null {
    const raw = storage[`kline-chart-prefs:${key}`]
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  }

  it('初始化时读取 localStorage 中的 params', () => {
    storage['kline-chart-prefs:test-read'] = JSON.stringify({
      order: ['VOL', 'KDJ'],
      visibility: { VOL: true, KDJ: true, MACD: true, BRICK: true },
      heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6 },
      params: { KDJ: { n: 14, m1: 5, m2: 3 } },
    })
    const { prefs } = useKlineChartPrefs('test-read', available)
    expect(prefs.value.params).toEqual({ KDJ: { n: 14, m1: 5, m2: 3 } })
  })

  it('update params 深合并并 debounce 写入 localStorage', () => {
    const { prefs, update } = useKlineChartPrefs('test-update', available)
    update({ params: { KDJ: { n: 14 } } })

    // 同步更新偏好
    expect(prefs.value.params).toEqual({
      KDJ: { n: 14, m1: DEFAULT_KDJ_PARAMS.m1, m2: DEFAULT_KDJ_PARAMS.m2 },
    })

    // debounce 未到期，不写入
    expect(window.localStorage.setItem).not.toHaveBeenCalled()

    vi.advanceTimersByTime(199)
    expect(window.localStorage.setItem).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(window.localStorage.setItem).toHaveBeenCalledTimes(1)

    const stored = storedFor('test-update')
    expect(stored?.params).toEqual({
      KDJ: { n: 14, m1: DEFAULT_KDJ_PARAMS.m1, m2: DEFAULT_KDJ_PARAMS.m2 },
    })
  })

  it('update({ params: undefined }) 清除已持久化的自定义参数并写入', () => {
    storage['kline-chart-prefs:test-clear'] = JSON.stringify({
      order: ['VOL', 'KDJ', 'MACD', 'BRICK'],
      visibility: { VOL: true, KDJ: true, MACD: true, BRICK: true },
      heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6 },
      params: { KDJ: { n: 14, m1: 5, m2: 3 } },
    })

    const { prefs, update } = useKlineChartPrefs('test-clear', available)
    expect(prefs.value.params).toBeDefined()

    update({ params: undefined })
    expect(prefs.value.params).toBeUndefined()
    expect('params' in prefs.value).toBe(false)

    vi.advanceTimersByTime(200)
    const stored = storedFor('test-clear')
    expect(stored?.params).toBeUndefined()
    expect('params' in (stored ?? {})).toBe(false)
  })

  it('非 params 更新不影响已有 params', () => {
    storage['kline-chart-prefs:test-keep'] = JSON.stringify({
      order: ['VOL', 'KDJ', 'MACD', 'BRICK'],
      visibility: { VOL: true, KDJ: true, MACD: true, BRICK: true },
      heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6 },
      params: { KDJ: { n: 14, m1: 5, m2: 3 } },
    })

    const { prefs, update } = useKlineChartPrefs('test-keep', available)
    update({ heightPct: { KDJ: 12 } as Record<SubplotKey, number> })
    vi.advanceTimersByTime(200)

    expect(prefs.value.params).toEqual({ KDJ: { n: 14, m1: 5, m2: 3 } })
    const stored = storedFor('test-keep')
    expect(stored?.params).toEqual({ KDJ: { n: 14, m1: 5, m2: 3 } })
  })

  it('连续多次 update 只触发一次写入', () => {
    const { update } = useKlineChartPrefs('test-debounce', available)
    update({ params: { KDJ: { n: 10 } } })
    vi.advanceTimersByTime(50)
    update({ params: { KDJ: { n: 11 } } })
    vi.advanceTimersByTime(150)
    update({ params: { KDJ: { n: 12 } } })
    vi.advanceTimersByTime(200)

    expect(window.localStorage.setItem).toHaveBeenCalledTimes(1)
    const stored = storedFor('test-debounce')
    expect(stored?.params).toEqual({
      KDJ: { n: 12, m1: DEFAULT_KDJ_PARAMS.m1, m2: DEFAULT_KDJ_PARAMS.m2 },
    })
  })
})

describe('useKlineChartPrefs — 后端迁移', () => {
  let storage: Record<string, string> = {}
  const available: readonly SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']

  /** 把 composable 挂在组件里以触发 onMounted 生命周期 */
  function mountComposable(
    prefsKey: string,
    availableSubplots: readonly SubplotKey[],
  ) {
    const captured: { value?: ReturnType<typeof useKlineChartPrefs> } = {}
    const Comp = defineComponent({
      setup() {
        captured.value = useKlineChartPrefs(prefsKey, availableSubplots)
        return () => h('div')
      },
    })
    const wrapper = mount(Comp)
    return { wrapper, api: captured.value! }
  }

  beforeEach(() => {
    storage = {}
    Object.defineProperty(window, 'localStorage', {
      value: {
        getItem: vi.fn((key: string) => storage[key] ?? null),
        setItem: vi.fn((key: string, value: string) => {
          storage[key] = value
        }),
        removeItem: vi.fn((key: string) => {
          delete storage[key]
        }),
        clear: vi.fn(() => {
          Object.keys(storage).forEach((k) => delete storage[k])
        }),
      },
      writable: true,
    })
    vi.useFakeTimers()
    mockGetKlinePrefs.mockClear()
    mockGetKlinePrefs.mockResolvedValue({ order: [] })
    mockSaveKlinePrefs.mockClear()
    mockSaveKlinePrefs.mockResolvedValue({ ok: true })
    _resetMigratedKeys()
  })

  afterEach(() => {
    vi.useRealTimers()
    vi.restoreAllMocks()
  })

  function storedFor(key: string): Record<string, unknown> | null {
    const raw = storage[`kline-chart-prefs:${key}`]
    return raw ? (JSON.parse(raw) as Record<string, unknown>) : null
  }

  it('onMounted GET 成功有数据 → prefs 被后端值覆盖', async () => {
    // localStorage 有旧数据
    storage['kline-chart-prefs:remote-override'] = JSON.stringify({
      order: ['VOL'],
      visibility: { VOL: true, KDJ: true, MACD: true, BRICK: true },
      heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6 },
    })

    // 后端返回不同数据
    mockGetKlinePrefs.mockResolvedValue({
      order: ['KDJ', 'VOL', 'MACD'],
      visibility: { VOL: true, KDJ: false, MACD: true, BRICK: true },
      heightPct: { KDJ: 12 },
      mainIndicators: { MA5: false, MA30: false },
    })

    const { wrapper, api } = mountComposable('remote-override', available)
    const { prefs } = api

    // 同步初始化用 localStorage (VOL only, rest appended by normalize)
    expect(prefs.value.order).toEqual(['VOL', 'KDJ', 'MACD', 'BRICK'])

    // 等待 onMounted 中的异步 GET 完成
    await vi.advanceTimersByTimeAsync(100)
    await nextTick()

    // 后端数据已覆盖
    expect(prefs.value.order).toEqual(['KDJ', 'VOL', 'MACD', 'BRICK'])
    expect(prefs.value.visibility.KDJ).toBe(false)
    expect(prefs.value.heightPct.KDJ).toBe(12)
    expect(prefs.value.mainIndicators?.MA5).toBe(false)
    expect(prefs.value.mainIndicators?.MA30).toBe(false)

    // localStorage 也被同步回写
    const stored = storedFor('remote-override')
    expect(stored?.order).toEqual(['KDJ', 'VOL', 'MACD', 'BRICK'])

    wrapper.unmount()
  })

  it('onMounted GET 失败 → 保持 localStorage/默认值(降级不炸)', async () => {
    mockGetKlinePrefs.mockRejectedValue(new Error('Network error'))

    storage['kline-chart-prefs:degrade'] = JSON.stringify({
      order: ['MACD', 'VOL'],
      visibility: { VOL: true, KDJ: true, MACD: true, BRICK: true },
      heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6 },
    })

    const { wrapper, api } = mountComposable('degrade', available)
    const { prefs } = api

    await vi.advanceTimersByTimeAsync(100)
    await nextTick()

    // 保持 localStorage 值，不崩溃
    expect(prefs.value.order).toEqual(['MACD', 'VOL', 'KDJ', 'BRICK'])

    wrapper.unmount()
  })

  it('onMounted GET 返回空 + localStorage 有数据 → 触发 PUT 迁移', async () => {
    // 后端返回空数据
    mockGetKlinePrefs.mockResolvedValue({ order: [] })

    storage['kline-chart-prefs:migrate'] = JSON.stringify({
      order: ['VOL', 'KDJ'],
      visibility: { VOL: true, KDJ: true, MACD: true, BRICK: true },
      heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6 },
    })

    const { wrapper, api } = mountComposable('migrate', available)

    await vi.advanceTimersByTimeAsync(100)
    await nextTick()

    // PUT 应被调用（一次性迁移）— 仅 1 次（onMounted 迁移），scheduleWrite 的 debounce 未到
    // mockSaveKlinePrefs 在 beforeEach 已清空
    expect(mockSaveKlinePrefs.mock.calls.length).toBeGreaterThanOrEqual(1)

    // 找到 onMounted 迁移的 PUT（body 应含 order）
    const migrationCall = mockSaveKlinePrefs.mock.calls.find(
      (call) => call[1]?.order?.length > 0,
    )
    expect(migrationCall).toBeDefined()
    expect(migrationCall![1].order).toContain('VOL')
    expect(migrationCall![1].order).toContain('KDJ')

    wrapper.unmount()
  })

  it('update 写入同时触发 localStorage.setItem 和 saveKlinePrefs', async () => {
    mockGetKlinePrefs.mockResolvedValue({ order: [] })

    const { wrapper, api } = mountComposable('dual-write', available)
    const { prefs, update } = api

    // 等 onMounted 完成
    await vi.advanceTimersByTimeAsync(100)
    await nextTick()

    // 清掉 onMounted 期间可能产生的调用
    mockSaveKlinePrefs.mockClear()
    ;(window.localStorage.setItem as any).mockClear()

    update({ heightPct: { KDJ: 15 } as Record<SubplotKey, number> })

    vi.advanceTimersByTime(200)

    // localStorage 被写入
    expect(window.localStorage.setItem).toHaveBeenCalled()
    // 后端 PUT 也被调用
    expect(mockSaveKlinePrefs).toHaveBeenCalled()
    const savedBody = mockSaveKlinePrefs.mock.calls[0]![1]
    expect(savedBody.heightPct).toEqual(expect.objectContaining({ KDJ: 15 }))

    wrapper.unmount()
  })

  it('update 的 mainIndicators 合并:已有 MA5:false 时 update({mainIndicators:{MA30:false}}) → 两者都保留', async () => {
    mockGetKlinePrefs.mockResolvedValue({ order: [] })

    // 初始化 localStorage 含 MA5:false
    storage['kline-chart-prefs:mi-merge'] = JSON.stringify({
      order: ['VOL', 'KDJ', 'MACD', 'BRICK'],
      visibility: { VOL: true, KDJ: true, MACD: true, BRICK: true },
      heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6 },
      mainIndicators: { MA5: false },
    })

    const { wrapper, api } = mountComposable('mi-merge', available)
    const { prefs, update } = api

    // 等 onMounted 完成
    await vi.advanceTimersByTimeAsync(100)
    await nextTick()

    // 初始: MA5 false, others default true
    expect(prefs.value.mainIndicators?.MA5).toBe(false)
    expect(prefs.value.mainIndicators?.MA30).toBe(true)

    // 只更新 MA30
    update({ mainIndicators: { MA30: false } } as any)
    expect(prefs.value.mainIndicators?.MA5).toBe(false)
    expect(prefs.value.mainIndicators?.MA30).toBe(false)
    expect(prefs.value.mainIndicators?.MA60).toBe(true)

    wrapper.unmount()
  })
})
