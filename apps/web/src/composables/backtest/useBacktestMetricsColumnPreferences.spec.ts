import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { SymbolColumnDef } from '@/components/symbols/columnTypes'
import { useBacktestMetricsColumnPreferences } from './useBacktestMetricsColumnPreferences'

const STORAGE_KEY = 'backtest-metrics-columns'

interface Row {
  a: number
}

function makeDefs(): SymbolColumnDef<Row>[] {
  return [
    { key: 'symbol', title: '标的', locked: true, defaultVisible: true, render: () => '' },
    { key: 'ma5', title: 'MA5', defaultVisible: true, sorter: true, render: () => '' },
    { key: 'ma30', title: 'MA30', defaultVisible: true, sorter: true, render: () => '' },
    { key: 'hidden', title: '隐藏', defaultVisible: false, render: () => '' },
  ]
}

describe('useBacktestMetricsColumnPreferences', () => {
  beforeEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  afterEach(() => {
    window.localStorage.clear()
    vi.restoreAllMocks()
  })

  it('无 localStorage 数据 → scopePreferences 取默认（locked + defaultVisible）', () => {
    const { scopePreferences } = useBacktestMetricsColumnPreferences(makeDefs())
    expect(scopePreferences.value).toEqual([
      { key: 'symbol', visible: true },
      { key: 'ma5', visible: true },
      { key: 'ma30', visible: true },
      { key: 'hidden', visible: false },
    ])
  })

  it('columnsBase 只含可见列，且不含 sortOrder', () => {
    const { columnsBase } = useBacktestMetricsColumnPreferences(makeDefs())
    const keys = columnsBase.value.map((c) => (c as { key: string }).key)
    expect(keys).toEqual(['symbol', 'ma5', 'ma30']) // hidden 默认不可见
    for (const col of columnsBase.value) {
      expect('sortOrder' in (col as object)).toBe(false)
    }
  })

  it('set scopePreferences → 写 localStorage（normalize 后）', () => {
    const { scopePreferences } = useBacktestMetricsColumnPreferences(makeDefs())
    scopePreferences.value = [
      { key: 'ma30', visible: false },
      { key: 'ma5', visible: true },
    ]
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)
    // normalize 补齐缺失键 + locked 强制 true，未列出的按 default
    expect(stored).toContainEqual({ key: 'symbol', visible: true })
    expect(stored).toContainEqual({ key: 'ma30', visible: false })
    expect(stored).toContainEqual({ key: 'ma5', visible: true })
  })

  it('从 localStorage 读回持久化偏好（隐藏 ma30）', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([
        { key: 'symbol', visible: true },
        { key: 'ma5', visible: true },
        { key: 'ma30', visible: false },
        { key: 'hidden', visible: true },
      ]),
    )
    const { scopePreferences, columnsBase } = useBacktestMetricsColumnPreferences(makeDefs())
    expect(scopePreferences.value.find((i) => i.key === 'ma30')!.visible).toBe(false)
    expect(scopePreferences.value.find((i) => i.key === 'hidden')!.visible).toBe(true)
    const keys = columnsBase.value.map((c) => (c as { key: string }).key)
    expect(keys).toEqual(['symbol', 'ma5', 'hidden']) // ma30 被隐藏
  })

  it('locked 列即使 localStorage 标 false 也强制可见', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ key: 'symbol', visible: false }]),
    )
    const { scopePreferences } = useBacktestMetricsColumnPreferences(makeDefs())
    expect(scopePreferences.value.find((i) => i.key === 'symbol')!.visible).toBe(true)
  })

  it('损坏的 JSON → 降级默认，不抛', () => {
    window.localStorage.setItem(STORAGE_KEY, '{not json')
    const { scopePreferences } = useBacktestMetricsColumnPreferences(makeDefs())
    expect(scopePreferences.value.map((i) => i.key)).toEqual(['symbol', 'ma5', 'ma30', 'hidden'])
  })

  it('reset() 恢复默认偏好并写回 localStorage', () => {
    const defs = makeDefs()
    const { scopePreferences, reset } = useBacktestMetricsColumnPreferences(defs)
    scopePreferences.value = [{ key: 'ma5', visible: false }]
    reset()
    expect(scopePreferences.value.find((i) => i.key === 'ma5')!.visible).toBe(true)
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)
    expect(stored).toContainEqual({ key: 'ma5', visible: true })
  })

  it('save() 持久化当前偏好并切换 saving', () => {
    window.localStorage.setItem(
      STORAGE_KEY,
      JSON.stringify([{ key: 'ma5', visible: false }]),
    )
    const { save, saving } = useBacktestMetricsColumnPreferences(makeDefs())
    expect(saving.value).toBe(false)
    save()
    expect(saving.value).toBe(false)
    const stored = JSON.parse(window.localStorage.getItem(STORAGE_KEY)!)
    expect(stored).toContainEqual({ key: 'ma5', visible: false })
  })

  it('localStorage.getItem 抛错（隐私模式）→ 读时降级默认，不抛', () => {
    vi.spyOn(window.localStorage.__proto__, 'getItem').mockImplementation(() => {
      throw new Error('SecurityError')
    })
    const { scopePreferences } = useBacktestMetricsColumnPreferences(makeDefs())
    expect(scopePreferences.value.map((i) => i.key)).toEqual(['symbol', 'ma5', 'ma30', 'hidden'])
  })

  it('localStorage.setItem 抛错（配额超限）→ 写时静默降级，不抛', () => {
    vi.spyOn(window.localStorage.__proto__, 'setItem').mockImplementation(() => {
      throw new Error('QuotaExceededError')
    })
    const { scopePreferences, save } = useBacktestMetricsColumnPreferences(makeDefs())
    expect(() => {
      scopePreferences.value = [{ key: 'ma5', visible: false }]
    }).not.toThrow()
    expect(() => save()).not.toThrow()
  })
})
