import { describe, expect, it } from 'vitest'
import { isVNode, ref as vueRef } from 'vue'
import { createWatchlistColumnDefs } from './watchlistColumnDefs'
import type { WatchlistQuoteRow } from '@/api'

/** 渲染产物归一为可断言文本：string 直接返回，VNode 取 children 文本 */
function renderText(node: unknown): string {
  if (typeof node === 'string') return node
  if (isVNode(node)) {
    const children = node.children as { default?: () => unknown } | unknown
    if (children && typeof (children as { default?: unknown }).default === 'function') {
      return String((children as { default: () => unknown }).default())
    }
    return String(children)
  }
  return String(node)
}

function makeColumns() {
  return createWatchlistColumnDefs({
    scoresMap: vueRef(new Map<string, number>()),
    scoresLoading: vueRef(false),
    hitLookup: vueRef(new Map<string, Set<string>>()),
    onViewChart: () => {},
    onRemove: () => {},
  })
}

// 改前内联声明的 19 个指标列 key（watchlistColumnDefs.ts:237-263），抽取后必须仍全部存在
const WATCHLIST_INDICATOR_KEYS = [
  'ma5', 'ma30', 'ma60', 'ma120', 'ma240',
  'kdjJ', 'kdjK', 'kdjD',
  'dif', 'dea', 'macd', 'bbi',
  'quoteVolume10', 'atr14', 'lossAtr14', 'low9', 'high9',
  'riskRewardRatio', 'stopLossPct',
] as const

describe('createWatchlistColumnDefs — 指标列复用共享目录（去重零漂移）', () => {
  it('产物仍含改前全部 19 个指标列 key', () => {
    const cols = makeColumns()
    const keys = new Set(cols.map((c) => c.key))
    for (const k of WATCHLIST_INDICATOR_KEYS) {
      expect(keys.has(k)).toBe(true)
    }
  })

  it('保留非指标列（symbol/name/tags/openTime/modelScore/buySignal/actions 等）', () => {
    const cols = makeColumns()
    const keys = new Set(cols.map((c) => c.key))
    for (const k of ['symbol', 'name', 'market', 'tags', 'openTime', 'modelScore', 'buySignal', 'actions']) {
      expect(keys.has(k)).toBe(true)
    }
  })

  it('默认可见集：ma5/ma30/kdjJ/riskRewardRatio=true，其余指标列=false', () => {
    const cols = makeColumns()
    const byKey = new Map(cols.map((c) => [c.key, c]))
    const visibleTrue = new Set(['ma5', 'ma30', 'kdjJ', 'riskRewardRatio'])
    for (const k of WATCHLIST_INDICATOR_KEYS) {
      expect(byKey.get(k)!.defaultVisible).toBe(visibleTrue.has(k))
    }
  })

  it('指标列 sorter 全 true（自选股本地排序，行为不变）', () => {
    const cols = makeColumns()
    const byKey = new Map(cols.map((c) => [c.key, c]))
    for (const k of WATCHLIST_INDICATOR_KEYS) {
      expect(byKey.get(k)!.sorter).toBe(true)
    }
  })

  it('指标列 descKey 对齐（kdjJ→kdj_j / riskRewardRatio→profit_loss_ratio / stopLossPct→stop_loss_pct）', () => {
    const cols = makeColumns()
    const byKey = new Map(cols.map((c) => [c.key, c]))
    expect(byKey.get('kdjJ')!.descKey).toBe('kdj_j')
    expect(byKey.get('dif')!.descKey).toBe('macd_dif')
    expect(byKey.get('atr14')!.descKey).toBe('atr14')
    expect(byKey.get('riskRewardRatio')!.descKey).toBe('profit_loss_ratio')
    expect(byKey.get('stopLossPct')!.descKey).toBe('stop_loss_pct')
    // 无 descKey 的列
    expect(byKey.get('ma5')!.descKey).toBeUndefined()
    expect(byKey.get('low9')!.descKey).toBeUndefined()
  })

  it('抽样 render 零漂移：ma5=4位 / kdjJ=2位 / stopLossPct 带 % / null→"-"', () => {
    const cols = makeColumns()
    const byKey = new Map(cols.map((c) => [c.key, c]))
    const make = (over: Partial<WatchlistQuoteRow>): WatchlistQuoteRow =>
      ({ symbol: '000001.SZ', ...over } as WatchlistQuoteRow)

    // ma5：4 位小数（number 输入）
    expect(renderText(byKey.get('ma5')!.render(make({ ma5: 12.3 })))).toBe('12.3000')
    // kdjJ：2 位小数（负值）
    expect(renderText(byKey.get('kdjJ')!.render(make({ kdjJ: -5.678 })))).toBe('-5.68')
    // stopLossPct：2 位 + %
    expect(renderText(byKey.get('stopLossPct')!.render(make({ stopLossPct: 3.5 })))).toBe('3.50%')
    // riskRewardRatio：2 位
    expect(renderText(byKey.get('riskRewardRatio')!.render(make({ riskRewardRatio: 1.234 })))).toBe('1.23')
    // null → '-'
    expect(renderText(byKey.get('ma5')!.render(make({ ma5: null })))).toBe('-')
    expect(renderText(byKey.get('stopLossPct')!.render(make({ stopLossPct: null })))).toBe('-')
    // 缺字段 → '-'（共享目录多出的 brick 列在 WatchlistQuoteRow 上无值）
    expect(renderText(byKey.get('ma5')!.render(make({})))).toBe('-')
  })
})
