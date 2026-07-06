import { describe, expect, it } from 'vitest'
import { isVNode, h } from 'vue'
import { colors } from '../../../styles/tokens'
import {
  INDICATOR_DESCRIPTORS,
  buildIndicatorColumns,
  type IndicatorDescriptor,
} from './indicatorColumnDefs'

type AnyRow = Record<string, unknown>

/** 渲染产物归一为可断言形态：string 直接返回，VNode 取其 children 文本 */
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

describe('INDICATOR_DESCRIPTORS', () => {
  // 注：spec 散文写「24 条 / 前 18 条」，但其逐键枚举表实为 22 条 watchlist 衍生列
  // （ma5..ma240/bbi/kdjJ..kdjD/dif/dea/macd/quoteVolume10/atr14/lossAtr14/low9/high9/
  //  riskRewardRatio/stopLossPct/roc10/roc20/roc60，与 A股/自选股/回测表共享字段逐列一致）
  // + 6 条 brick/amv 新增 = 28。表是 load-bearing 单一事实源，散文计数是 off-by-one，以表为准。
  it('恰好 31 条（22 共享指标 + 6 brick/amv + 3 obv）', () => {
    expect(INDICATOR_DESCRIPTORS).toHaveLength(31)
  })

  it('key 唯一', () => {
    const keys = INDICATOR_DESCRIPTORS.map((d) => d.key)
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('与 watchlist 对齐的关键 descriptor 取值正确', () => {
    const byKey = new Map(INDICATOR_DESCRIPTORS.map((d) => [d.key, d]))

    // 小数位
    expect(byKey.get('ma5')!.decimals).toBe(4)
    expect(byKey.get('kdjJ')!.decimals).toBe(2)
    expect(byKey.get('riskRewardRatio')!.decimals).toBe(2)
    expect(byKey.get('quoteVolume10')!.decimals).toBe(2)

    // title
    expect(byKey.get('riskRewardRatio')!.title).toBe('RR')
    expect(byKey.get('stopLossPct')!.title).toBe('Stop %')
    expect(byKey.get('quoteVolume10')!.title).toBe('10日成交额')

    // descKey 挂载
    expect(byKey.get('bbi')!.descKey).toBe('bbi')
    expect(byKey.get('macd')!.descKey).toBe('macd_hist')
    expect(byKey.get('stopLossPct')!.descKey).toBe('stop_loss_pct')

    // 无 descKey 的列
    expect(byKey.get('ma5')!.descKey).toBeUndefined()
    expect(byKey.get('low9')!.descKey).toBeUndefined()

    // suffix 仅 stopLossPct 有
    expect(byKey.get('stopLossPct')!.suffix).toBe('%')
    expect(byKey.get('ma5')!.suffix).toBeUndefined()

    // signal 列
    expect(byKey.get('brickXg')!.kind).toBe('signal')
    expect(byKey.get('brick')!.kind).toBeUndefined()
  })
})

describe('buildIndicatorColumns', () => {
  it('产物列数 = 31，且 key 顺序与 descriptor 一致', () => {
    const cols = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {})
    expect(cols).toHaveLength(31)
    expect(cols.map((c) => c.key)).toEqual(INDICATOR_DESCRIPTORS.map((d) => d.key))
  })

  it('每列携带 title(string) / descKey / width / sorter / render', () => {
    const cols = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {})
    const stop = cols.find((c) => c.key === 'stopLossPct')!
    expect(typeof stop.title).toBe('string')
    expect(stop.title).toBe('Stop %')
    expect(stop.descKey).toBe('stop_loss_pct')
    expect(typeof stop.render).toBe('function')

    const ma5 = cols.find((c) => c.key === 'ma5')!
    expect(ma5.descKey).toBeUndefined()
  })

  it('number 列按 decimals 格式化（与 formatFixed 等价）', () => {
    const cols = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {})
    const ma5 = cols.find((c) => c.key === 'ma5')!
    // string 输入（A股）
    expect(renderText(ma5.render({ ma5: '12.3' }))).toBe('12.3000')
    // number 输入（回测）
    expect(renderText(ma5.render({ ma5: 12.3 }))).toBe('12.3000')

    const kdjJ = cols.find((c) => c.key === 'kdjJ')!
    expect(renderText(kdjJ.render({ kdjJ: -5.678 }))).toBe('-5.68')
  })

  it('stopLossPct 末尾带 % 后缀', () => {
    const cols = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {})
    const stop = cols.find((c) => c.key === 'stopLossPct')!
    expect(renderText(stop.render({ stopLossPct: 3.5 }))).toBe('3.50%')
    expect(renderText(stop.render({ stopLossPct: '3.5' }))).toBe('3.50%')
  })

  it('number 列 null / undefined / NaN / 缺字段 → "-"', () => {
    const cols = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {})
    const ma5 = cols.find((c) => c.key === 'ma5')!
    expect(renderText(ma5.render({ ma5: null }))).toBe('-')
    expect(renderText(ma5.render({ ma5: undefined }))).toBe('-')
    expect(renderText(ma5.render({ ma5: 'abc' }))).toBe('-')
    expect(renderText(ma5.render({}))).toBe('-') // Row 缺该字段
  })

  it('blankWhen 命中 → "-"（即使有有效值）', () => {
    const cols = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {
      blankWhen: (row) => row.dataStatus === 'partial',
    })
    const ma5 = cols.find((c) => c.key === 'ma5')!
    expect(renderText(ma5.render({ ma5: 12.3, dataStatus: 'partial' }))).toBe('-')
    expect(renderText(ma5.render({ ma5: 12.3, dataStatus: 'ok' }))).toBe('12.3000')
  })

  it('signal 列(brickXg) 渲染 真/假，不走 toFixed；null → "-"', () => {
    const cols = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {})
    const xg = cols.find((c) => c.key === 'brickXg')!
    const trueNode = xg.render({ brickXg: true })
    const falseNode = xg.render({ brickXg: false })
    expect(isVNode(trueNode)).toBe(true)
    expect(renderText(trueNode)).toBe('真')
    expect(renderText(falseNode)).toBe('假')
    // null / 缺字段 → '-'（非 VNode）
    expect(renderText(xg.render({ brickXg: null }))).toBe('-')
    expect(renderText(xg.render({}))).toBe('-')
  })

  it('defaultVisible 传 boolean：全列统一', () => {
    const allOff = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, { defaultVisible: false })
    expect(allOff.every((c) => c.defaultVisible === false)).toBe(true)

    const allOn = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, { defaultVisible: true })
    expect(allOn.every((c) => c.defaultVisible === true)).toBe(true)
  })

  it('defaultVisible 传函数：按 key 逐列决定（自选股形态）', () => {
    const visibleSet = new Set(['ma5', 'ma30', 'kdjJ', 'riskRewardRatio'])
    const cols = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {
      defaultVisible: (k) => visibleSet.has(k),
    })
    expect(cols.find((c) => c.key === 'ma5')!.defaultVisible).toBe(true)
    expect(cols.find((c) => c.key === 'ma30')!.defaultVisible).toBe(true)
    expect(cols.find((c) => c.key === 'kdjJ')!.defaultVisible).toBe(true)
    expect(cols.find((c) => c.key === 'riskRewardRatio')!.defaultVisible).toBe(true)
    expect(cols.find((c) => c.key === 'ma60')!.defaultVisible).toBe(false)
    expect(cols.find((c) => c.key === 'brickXg')!.defaultVisible).toBe(false)
  })

  it('sorter 默认 true，可关', () => {
    const def = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {})
    expect(def.every((c) => c.sorter === true)).toBe(true)

    const off = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, { sortable: false })
    expect(off.every((c) => c.sorter === false)).toBe(true)
  })

  it('width 默认 110，可覆盖', () => {
    const def = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, {})
    expect(def.every((c) => c.width === 110)).toBe(true)

    const wide = buildIndicatorColumns<AnyRow>(INDICATOR_DESCRIPTORS, { width: 130 })
    expect(wide.every((c) => c.width === 130)).toBe(true)
  })

  it('自定义 accessor 生效', () => {
    const descriptors: IndicatorDescriptor[] = [{ key: 'ma5', title: 'MA5', decimals: 2 }]
    const cols = buildIndicatorColumns<AnyRow>(descriptors, {
      accessor: (row) => row.nested,
    })
    expect(renderText(cols[0].render({ nested: 9.999 }))).toBe('10.00')
  })

  describe('obv 千元→亿换算', () => {
    it('divisor + suffix 将千元缩放为亿', () => {
      const descriptors: IndicatorDescriptor[] = [
        { key: 'obv5d', title: 'OBV5D', decimals: 2, divisor: 100000, suffix: ' 亿' },
      ]
      const cols = buildIndicatorColumns<AnyRow>(descriptors)
      const rendered = cols[0].render({ obv5d: 18007267 })
      expect(renderText(rendered)).toBe('180.07 亿')
    })

    it('无 divisor 时原值直出（不缩放）', () => {
      const descriptors: IndicatorDescriptor[] = [
        { key: 'ma5', title: 'MA5', decimals: 2 },
      ]
      const cols = buildIndicatorColumns<AnyRow>(descriptors)
      expect(renderText(cols[0].render({ ma5: 123.45 }))).toBe('123.45')
    })

    it('null / NaN 仍返回 "-"', () => {
      const descriptors: IndicatorDescriptor[] = [
        { key: 'obv5d', title: 'OBV5D', decimals: 2, divisor: 100000, suffix: ' 亿' },
      ]
      const cols = buildIndicatorColumns<AnyRow>(descriptors)
      expect(renderText(cols[0].render({ obv5d: null }))).toBe('-')
      expect(renderText(cols[0].render({ obv5d: 'abc' }))).toBe('-')
    })
  })

  describe('colorBySign 着色', () => {
    const descriptors: IndicatorDescriptor[] = [
      { key: 'obv5d', title: 'OBV5D', decimals: 2, divisor: 100000, suffix: ' 亿', colorBySign: true },
    ]

    function obvCol() {
      return buildIndicatorColumns<AnyRow>(descriptors)[0]
    }

    it('正值返回 VNode（span）且 color 为 success', () => {
      const rendered = obvCol().render({ obv5d: 18007267 })
      expect(isVNode(rendered)).toBe(true)
      expect(typeof renderText(rendered)).toBe('string')
      expect(renderText(rendered)).toBe('180.07 亿')
      const props = (rendered as ReturnType<typeof h>).props as { style?: { color?: string } }
      expect(props?.style?.color).toBe(colors.success.DEFAULT)
    })

    it('负值返回 VNode（span）且 color 为 error', () => {
      const rendered = obvCol().render({ obv5d: -50000000 })
      expect(isVNode(rendered)).toBe(true)
      expect(renderText(rendered)).toBe('-500.00 亿')
      const props = (rendered as ReturnType<typeof h>).props as { style?: { color?: string } }
      expect(props?.style?.color).toBe(colors.error.DEFAULT)
    })

    it('零值返回纯字符串（无 span 包裹）', () => {
      const rendered = obvCol().render({ obv5d: 0 })
      expect(typeof rendered).toBe('string')
      expect(rendered).toBe('0.00 亿')
    })

    it('null 返回 "-"（纯字符串）', () => {
      const rendered = obvCol().render({ obv5d: null })
      expect(typeof rendered).toBe('string')
      expect(rendered).toBe('-')
    })
  })
})
