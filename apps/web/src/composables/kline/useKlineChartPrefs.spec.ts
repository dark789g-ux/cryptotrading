import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { useKlineChartPrefs } from './useKlineChartPrefs'
import { DEFAULT_KDJ_PARAMS, type SubplotKey } from './subplotConfig'

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
  })

  afterEach(() => {
    vi.useRealTimers()
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
      params: { n: 14, m1: 5, m2: 3 },
    })
    const { prefs } = useKlineChartPrefs('test-read', available)
    expect(prefs.value.params).toEqual({ n: 14, m1: 5, m2: 3 })
  })

  it('update params 深合并并 debounce 写入 localStorage', () => {
    const { prefs, update } = useKlineChartPrefs('test-update', available)
    update({ params: { n: 14 } })

    // 同步更新偏好
    expect(prefs.value.params).toEqual({
      n: 14,
      m1: DEFAULT_KDJ_PARAMS.m1,
      m2: DEFAULT_KDJ_PARAMS.m2,
    })

    // debounce 未到期，不写入
    expect(window.localStorage.setItem).not.toHaveBeenCalled()

    vi.advanceTimersByTime(199)
    expect(window.localStorage.setItem).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    expect(window.localStorage.setItem).toHaveBeenCalledTimes(1)

    const stored = storedFor('test-update')
    expect(stored?.params).toEqual({
      n: 14,
      m1: DEFAULT_KDJ_PARAMS.m1,
      m2: DEFAULT_KDJ_PARAMS.m2,
    })
  })

  it('update({ params: undefined }) 清除已持久化的自定义参数并写入', () => {
    storage['kline-chart-prefs:test-clear'] = JSON.stringify({
      order: ['VOL', 'KDJ', 'MACD', 'BRICK'],
      visibility: { VOL: true, KDJ: true, MACD: true, BRICK: true },
      heightPct: { VOL: 8, KDJ: 8, MACD: 8, BRICK: 6 },
      params: { n: 14, m1: 5, m2: 3 },
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
      params: { n: 14, m1: 5, m2: 3 },
    })

    const { prefs, update } = useKlineChartPrefs('test-keep', available)
    update({ heightPct: { KDJ: 12 } as Record<SubplotKey, number> })
    vi.advanceTimersByTime(200)

    expect(prefs.value.params).toEqual({ n: 14, m1: 5, m2: 3 })
    const stored = storedFor('test-keep')
    expect(stored?.params).toEqual({ n: 14, m1: 5, m2: 3 })
  })

  it('连续多次 update 只触发一次写入', () => {
    const { update } = useKlineChartPrefs('test-debounce', available)
    update({ params: { n: 10 } })
    vi.advanceTimersByTime(50)
    update({ params: { n: 11 } })
    vi.advanceTimersByTime(150)
    update({ params: { n: 12 } })
    vi.advanceTimersByTime(200)

    expect(window.localStorage.setItem).toHaveBeenCalledTimes(1)
    const stored = storedFor('test-debounce')
    expect(stored?.params).toEqual({
      n: 12,
      m1: DEFAULT_KDJ_PARAMS.m1,
      m2: DEFAULT_KDJ_PARAMS.m2,
    })
  })
})
