import { describe, expect, it } from 'vitest'
import { isVNode } from 'vue'
import { createUsStocksColumnDefs, US_INDICATOR_DESCRIPTORS } from './usStocksColumns'
import { INDICATOR_DESCRIPTORS } from '../columns/indicatorColumnDefs'
import type { UsStockRow } from '@/api'

/** 渲染产物归一为可断言文本：string 直接返回，VNode 取其 default slot 文本 */
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

function makeOptions() {
  return {
    onViewDetail: () => {},
    priceMode: 'qfq' as const,
  }
}

const US_INDICATOR_KEYS = US_INDICATOR_DESCRIPTORS.map((d) => d.key)

describe('createUsStocksColumnDefs · 美股列定义', () => {
  it('含基础列 ticker/name/theme/stockType/close/pctChg/volume/tradeDate + actions', () => {
    const cols = createUsStocksColumnDefs(makeOptions())
    const keys = cols.map((c) => c.key)
    for (const k of ['ticker', 'name', 'theme', 'stockType', 'close', 'pctChg', 'volume', 'tradeDate', 'actions']) {
      expect(keys).toContain(k)
    }
  })

  it('US 指标子集严格对齐后端 17 个指标，排除 quoteVolume10/lossAtr14/brick*/amv*', () => {
    expect(US_INDICATOR_KEYS).toHaveLength(17)
    for (const k of ['quoteVolume10', 'lossAtr14', 'brick', 'brickDelta', 'brickXg', 'amvDif', 'amvDea', 'amvMacd']) {
      expect(US_INDICATOR_KEYS).not.toContain(k)
    }
    const expected = [
      'ma5', 'ma30', 'ma60', 'ma120', 'ma240', 'bbi', 'kdjJ', 'kdjK', 'kdjD',
      'dif', 'dea', 'macd', 'atr14', 'low9', 'high9', 'riskRewardRatio', 'stopLossPct',
    ]
    expect([...US_INDICATOR_KEYS].sort()).toEqual([...expected].sort())
    // 子集严格小于全集（全集含 quoteVolume10/lossAtr14/brick/amv）
    expect(US_INDICATOR_KEYS.length).toBeLessThan(INDICATOR_DESCRIPTORS.length)
  })

  it('无评分列(modelScore)、无买入信号列(buySignal)、无标签列(tags)', () => {
    const cols = createUsStocksColumnDefs(makeOptions())
    const keys = cols.map((c) => c.key)
    expect(keys).not.toContain('modelScore')
    expect(keys).not.toContain('buySignal')
    expect(keys).not.toContain('tags')
  })

  it('所有指标列 defaultVisible === false（默认隐藏）', () => {
    const cols = createUsStocksColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))
    for (const k of US_INDICATOR_KEYS) {
      expect(byKey.get(k)!.defaultVisible).toBe(false)
    }
  })

  it('指标列 splice 在 tradeDate 之后、actions 之前', () => {
    const cols = createUsStocksColumnDefs(makeOptions())
    const keys = cols.map((c) => c.key)
    const tradeDateIdx = keys.indexOf('tradeDate')
    const actionsIdx = keys.indexOf('actions')
    expect(actionsIdx).toBeGreaterThan(tradeDateIdx)
    for (const k of US_INDICATOR_KEYS) {
      const idx = keys.indexOf(k)
      expect(idx).toBeGreaterThan(tradeDateIdx)
      expect(idx).toBeLessThan(actionsIdx)
    }
  })

  it('指标列 sorter:true（remote 表头排序）', () => {
    const cols = createUsStocksColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))
    for (const k of US_INDICATOR_KEYS) {
      expect(byKey.get(k)!.sorter).toBe(true)
    }
  })

  it('ticker / actions 列 locked', () => {
    const cols = createUsStocksColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))
    expect(byKey.get('ticker')!.locked).toBe(true)
    expect(byKey.get('actions')!.locked).toBe(true)
  })

  it('数值指标列 render：string 输入按 decimals 格式化，null/缺字段 → "-"', () => {
    const cols = createUsStocksColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))

    const ma5 = byKey.get('ma5')!
    expect(renderText(ma5.render({ ma5: '12.3' } as unknown as UsStockRow))).toBe('12.3000')
    expect(renderText(ma5.render({ ma5: null } as unknown as UsStockRow))).toBe('-')
    expect(renderText(ma5.render({} as unknown as UsStockRow))).toBe('-')

    const stop = byKey.get('stopLossPct')!
    expect(renderText(stop.render({ stopLossPct: '3.5' } as unknown as UsStockRow))).toBe('3.50%')
  })

  it('priceMode raw 时列头后缀为「原始」', () => {
    const colsRaw = createUsStocksColumnDefs({ ...makeOptions(), priceMode: 'raw' })
    const closeRaw = colsRaw.find((c) => c.key === 'close')!
    expect(closeRaw.title).toContain('原始')
    const colsQfq = createUsStocksColumnDefs(makeOptions())
    const closeQfq = colsQfq.find((c) => c.key === 'close')!
    expect(closeQfq.title).toContain('前复权')
  })
})
