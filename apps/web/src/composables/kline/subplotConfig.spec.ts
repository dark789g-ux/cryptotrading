import { describe, it, expect } from 'vitest'
import {
  DEFAULT_KDJ_PARAMS,
  KDJ_PARAM_RANGES,
  normalizeIndicatorParams,
  isDefaultKdjParams,
  normalizePrefs,
  defaultPrefsFor,
  type SubplotKey,
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
