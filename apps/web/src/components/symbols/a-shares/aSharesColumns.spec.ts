import { describe, expect, it } from 'vitest'
import { isVNode, ref } from 'vue'
import { createASharesColumnDefs } from './aSharesColumns'
import { INDICATOR_DESCRIPTORS } from '../columns/indicatorColumnDefs'
import type { AShareRow } from '@/api'

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
    scoresMap: ref(new Map<string, number>()),
    scoresLoading: ref(false),
  }
}

const INDICATOR_KEYS = INDICATOR_DESCRIPTORS.map((d) => d.key)

describe('createASharesColumnDefs · 技术指标列接入', () => {
  it('含全部 28 个指标列 key', () => {
    const cols = createASharesColumnDefs(makeOptions())
    const keys = cols.map((c) => c.key)
    expect(INDICATOR_KEYS).toHaveLength(28)
    for (const k of INDICATOR_KEYS) {
      expect(keys).toContain(k)
    }
  })

  it('所有指标列 defaultVisible === false（A股 全部默认隐藏）', () => {
    const cols = createASharesColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))
    for (const k of INDICATOR_KEYS) {
      expect(byKey.get(k)!.defaultVisible).toBe(false)
    }
  })

  it('申万行业列优先显示名称，缺名称时回退代码', () => {
    const cols = createASharesColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))
    const l1 = byKey.get('swIndustryL1Code')!
    expect(renderText(l1.render({ swIndustryL1Code: '801780.SI', swIndustryL1Name: '银行' } as unknown as AShareRow))).toBe('银行')
    expect(renderText(l1.render({ swIndustryL1Code: '801780.SI', swIndustryL1Name: null } as unknown as AShareRow))).toBe('801780.SI')
    expect(renderText(l1.render({ swIndustryL1Code: null, swIndustryL1Name: null } as unknown as AShareRow))).toBe('-')
  })

  it('非指标列可见性不变（原有列默认可见性保持）', () => {
    const cols = createASharesColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))
    // 原本默认可见
    expect(byKey.get('tsCode')!.defaultVisible).toBe(true)
    expect(byKey.get('close')!.defaultVisible).toBe(true)
    expect(byKey.get('tags')!.defaultVisible).toBe(true)
    expect(byKey.get('actions')!.defaultVisible).toBe(true)
    // 原本默认隐藏
    expect(byKey.get('totalMv')!.defaultVisible).toBe(false)
    expect(byKey.get('circMv')!.defaultVisible).toBe(false)
  })

  it('指标列 splice 在 tags 之后、actions 之前', () => {
    const cols = createASharesColumnDefs(makeOptions())
    const keys = cols.map((c) => c.key)
    const tagsIdx = keys.indexOf('tags')
    const actionsIdx = keys.indexOf('actions')
    const ma5Idx = keys.indexOf('ma5')
    const amvMacdIdx = keys.indexOf('amvMacd')
    expect(tagsIdx).toBeGreaterThanOrEqual(0)
    expect(actionsIdx).toBeGreaterThan(tagsIdx)
    // 全部指标列落在 (tags, actions) 之间
    for (const k of INDICATOR_KEYS) {
      const idx = keys.indexOf(k)
      expect(idx).toBeGreaterThan(tagsIdx)
      expect(idx).toBeLessThan(actionsIdx)
    }
    // 首尾指标列锚点检查
    expect(ma5Idx).toBeGreaterThan(tagsIdx)
    expect(amvMacdIdx).toBeLessThan(actionsIdx)
  })

  it('指标列 sorter:true（remote 表头排序）', () => {
    const cols = createASharesColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))
    for (const k of INDICATOR_KEYS) {
      expect(byKey.get(k)!.sorter).toBe(true)
    }
  })

  it('数值指标列 render：string 输入按 decimals 格式化，null/缺字段 → "-"', () => {
    const cols = createASharesColumnDefs(makeOptions())
    const byKey = new Map(cols.map((c) => [c.key, c]))

    const ma5 = byKey.get('ma5')!
    expect(renderText(ma5.render({ ma5: '12.3' } as unknown as AShareRow))).toBe('12.3000')
    expect(renderText(ma5.render({ ma5: null } as unknown as AShareRow))).toBe('-')
    expect(renderText(ma5.render({} as unknown as AShareRow))).toBe('-')

    const stop = byKey.get('stopLossPct')!
    expect(renderText(stop.render({ stopLossPct: '3.5' } as unknown as AShareRow))).toBe('3.50%')
  })

  it('signal 指标列 brickXg：boolean 输入渲染 真/假（不走 toFixed），null → "-"', () => {
    const cols = createASharesColumnDefs(makeOptions())
    const xg = cols.find((c) => c.key === 'brickXg')!
    const trueNode = xg.render({ brickXg: true } as unknown as AShareRow)
    expect(isVNode(trueNode)).toBe(true)
    expect(renderText(trueNode)).toBe('真')
    expect(renderText(xg.render({ brickXg: false } as unknown as AShareRow))).toBe('假')
    expect(renderText(xg.render({ brickXg: null } as unknown as AShareRow))).toBe('-')
  })
})
