import { describe, it, expect } from 'vitest'
import {
  DEFAULT_KDJ_PARAMS,
  KDJ_PARAM_RANGES,
  normalizeIndicatorParams,
  isDefaultKdjParams,
  normalizePrefs,
  normalizeMainIndicators,
  defaultPrefsFor,
  ALL_MAIN_INDICATOR_KEYS,
  DEFAULT_MAIN_INDICATOR_VISIBILITY,
  type SubplotKey,
  type MainIndicatorKey,
} from './subplotConfig'

describe('normalizeIndicatorParams', () => {
  it('空值返回空对象（默认参数被省略）', () => {
    expect(normalizeIndicatorParams()).toEqual({})
    expect(normalizeIndicatorParams(null)).toEqual({})
  })

  it('完整合法参数原样返回', () => {
    const p = { KDJ: { n: 14, m1: 5, m2: 3 } }
    expect(normalizeIndicatorParams(p)).toEqual(p)
  })

  it('partial 参数用默认值补齐', () => {
    expect(normalizeIndicatorParams({ KDJ: { n: 20 } })).toEqual({
      KDJ: { n: 20, m1: DEFAULT_KDJ_PARAMS.m1, m2: DEFAULT_KDJ_PARAMS.m2 },
    })
  })

  it('越界值回退到默认值并省略', () => {
    expect(
      normalizeIndicatorParams({
        KDJ: {
          n: KDJ_PARAM_RANGES.n[0] - 1,
          m1: KDJ_PARAM_RANGES.m1[1] + 1,
          m2: 0,
        },
      }),
    ).toEqual({})
  })

  it('非数字 / NaN / Infinity 回退到默认值并省略', () => {
    expect(normalizeIndicatorParams({ KDJ: { n: NaN, m1: Infinity, m2: -Infinity } })).toEqual({})
    expect(normalizeIndicatorParams({ KDJ: { n: 'x' as unknown as number } })).toEqual({})
  })
})

describe('isDefaultKdjParams', () => {
  it('空值视为默认', () => {
    expect(isDefaultKdjParams()).toBe(true)
    expect(isDefaultKdjParams(null)).toBe(true)
    expect(isDefaultKdjParams(undefined)).toBe(true)
  })

  it('完整默认值返回 true', () => {
    expect(isDefaultKdjParams(DEFAULT_KDJ_PARAMS)).toBe(true)
  })

  it('partial 默认返回 true', () => {
    expect(isDefaultKdjParams({})).toBe(true)
    expect(isDefaultKdjParams({ m1: DEFAULT_KDJ_PARAMS.m1 })).toBe(true)
  })

  it('任一字段非默认返回 false', () => {
    expect(isDefaultKdjParams({ n: 14 })).toBe(false)
    expect(isDefaultKdjParams({ m1: 1 })).toBe(false)
    expect(isDefaultKdjParams({ m2: 5 })).toBe(false)
  })
})

describe('normalizePrefs — params 处理', () => {
  const available: readonly SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']

  it('保留合法的自定义 params', () => {
    const raw = { params: { KDJ: { n: 14, m1: 5, m2: 3 } } }
    const prefs = normalizePrefs(raw, 'a-share', available)
    expect(prefs.params).toEqual(raw.params)
  })

  it('默认值 params 被省略', () => {
    const prefs = normalizePrefs({ params: { KDJ: DEFAULT_KDJ_PARAMS } }, 'a-share', available)
    expect(prefs.params).toBeUndefined()
    expect('params' in prefs).toBe(false)
  })

  it('越界 params 被清理回默认值并省略', () => {
    const prefs = normalizePrefs(
      { params: { KDJ: { n: 1, m1: 999, m2: 0 } } },
      'a-share',
      available,
    )
    expect(prefs.params).toBeUndefined()
  })

  it('params 与 visibility/heightPct 合并互不干扰', () => {
    const raw = {
      visibility: { KDJ: false } as Record<SubplotKey, boolean>,
      heightPct: { KDJ: 12 } as Record<SubplotKey, number>,
      params: { KDJ: { n: 14 } },
    }
    const prefs = normalizePrefs(raw, 'a-share', available)
    expect(prefs.visibility.KDJ).toBe(false)
    expect(prefs.heightPct.KDJ).toBe(12)
    expect(prefs.params).toEqual({ KDJ: { n: 14, m1: 3, m2: 3 } })
  })

  it('无 raw params 时结果不含 params', () => {
    const prefs = normalizePrefs({}, 'a-share', available)
    expect(prefs.params).toBeUndefined()
  })

  it('defaultPrefsFor 不含 params 字段', () => {
    const defaults = defaultPrefsFor('a-share')
    expect(defaults.params).toBeUndefined()
    expect('params' in defaults).toBe(false)
  })
})

describe('ALL_MAIN_INDICATOR_KEYS', () => {
  it('包含 8 个 key 且顺序正确', () => {
    expect(ALL_MAIN_INDICATOR_KEYS).toHaveLength(8)
    expect(ALL_MAIN_INDICATOR_KEYS).toEqual([
      'MA5', 'MA30', 'MA60', 'MA120', 'MA240',
      'VWAP5', 'VWAP10', 'VWAP20',
    ])
  })
})

describe('DEFAULT_MAIN_INDICATOR_VISIBILITY', () => {
  it('全 true', () => {
    for (const key of ALL_MAIN_INDICATOR_KEYS) {
      expect(DEFAULT_MAIN_INDICATOR_VISIBILITY[key]).toBe(true)
    }
  })
})

describe('normalizeMainIndicators', () => {
  it('null / undefined 返回全 true', () => {
    const result1 = normalizeMainIndicators(null)
    const result2 = normalizeMainIndicators(undefined)
    for (const key of ALL_MAIN_INDICATOR_KEYS) {
      expect(result1[key]).toBe(true)
      expect(result2[key]).toBe(true)
    }
  })

  it('partial 输入：只传部分 key，未传项补 true', () => {
    const result = normalizeMainIndicators({ MA5: false, VWAP20: false } as Partial<Record<MainIndicatorKey, boolean>>)
    expect(result.MA5).toBe(false)
    expect(result.VWAP20).toBe(false)
    // 其余默认 true
    expect(result.MA30).toBe(true)
    expect(result.VWAP5).toBe(true)
    expect(result.VWAP10).toBe(true)
  })

  it('非 boolean 值被忽略，按默认 true 处理', () => {
    const result = normalizeMainIndicators({
      MA5: 'yes' as unknown as boolean,
      MA30: 1 as unknown as boolean,
      VWAP5: null as unknown as boolean,
    } as Partial<Record<MainIndicatorKey, boolean>>)
    // 非 boolean 值被忽略，保留默认 true
    expect(result.MA5).toBe(true)
    expect(result.MA30).toBe(true)
    expect(result.VWAP5).toBe(true)
  })

  it('空对象返回全 true', () => {
    const result = normalizeMainIndicators({})
    for (const key of ALL_MAIN_INDICATOR_KEYS) {
      expect(result[key]).toBe(true)
    }
  })
})

describe('defaultPrefsFor — mainIndicators', () => {
  it('返回值含 mainIndicators 且全 true', () => {
    const prefs = defaultPrefsFor('a-share')
    expect(prefs.mainIndicators).toBeDefined()
    for (const key of ALL_MAIN_INDICATOR_KEYS) {
      expect(prefs.mainIndicators![key]).toBe(true)
    }
  })
})

describe('normalizePrefs — mainIndicators 处理', () => {
  const available: readonly SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']

  it('传入 raw 含 mainIndicators partial → 补全所有 key', () => {
    const raw = {
      mainIndicators: { MA5: false, VWAP10: false } as Partial<Record<MainIndicatorKey, boolean>>,
    }
    const prefs = normalizePrefs(raw, 'a-share', available)
    expect(prefs.mainIndicators!.MA5).toBe(false)
    expect(prefs.mainIndicators!.VWAP10).toBe(false)
    // 其余补 true
    expect(prefs.mainIndicators!.MA30).toBe(true)
    expect(prefs.mainIndicators!.VWAP20).toBe(true)
  })

  it('不传 mainIndicators → 补全为全 true', () => {
    const prefs = normalizePrefs({}, 'a-share', available)
    expect(prefs.mainIndicators).toBeDefined()
    for (const key of ALL_MAIN_INDICATOR_KEYS) {
      expect(prefs.mainIndicators![key]).toBe(true)
    }
  })

  it('mainIndicators 不依赖 availableSubplots 白名单(所有视图通用)', () => {
    // 即使 availableSubplots 为空，mainIndicators 仍然正常归一化
    const prefs = normalizePrefs(
      { mainIndicators: { MA60: false } } as any,
      'a-share',
      [],
    )
    expect(prefs.mainIndicators!.MA60).toBe(false)
    expect(prefs.mainIndicators!.MA5).toBe(true)
  })

  it('mainIndicators 与 params/visibility/heightPct 互不干扰', () => {
    const raw = {
      visibility: { KDJ: false } as Record<SubplotKey, boolean>,
      heightPct: { KDJ: 12 } as Record<SubplotKey, number>,
      params: { KDJ: { n: 14 } },
      mainIndicators: { MA30: false } as Partial<Record<MainIndicatorKey, boolean>>,
    }
    const prefs = normalizePrefs(raw, 'a-share', available)
    expect(prefs.visibility.KDJ).toBe(false)
    expect(prefs.heightPct.KDJ).toBe(12)
    expect(prefs.params).toEqual({ KDJ: { n: 14, m1: 3, m2: 3 } })
    expect(prefs.mainIndicators!.MA30).toBe(false)
    expect(prefs.mainIndicators!.MA5).toBe(true)
  })
})
