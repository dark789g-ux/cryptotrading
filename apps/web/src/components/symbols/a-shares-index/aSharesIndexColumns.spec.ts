import { describe, expect, it, vi } from 'vitest'
import { isVNode } from 'vue'
import { createASharesIndexColumnDefs } from './aSharesIndexColumns'
import type { IndexLatestRow } from './types'
import { colors } from '../../../styles/tokens'

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

const baseRow: IndexLatestRow = {
  tsCode: '000001.SH',
  name: '上证指数',
  category: 'market',
  tradeDate: '20250618',
  close: 3000,
  pctChange: 0.5,
  vol: 100,
  amount: 200,
  totalMvWan: null,
  pe: null,
  pb: null,
  count: null,
  netAmount: null,
  netAmount5d: null,
  netAmount10d: null,
  netAmount20d: null,
  obv5d: null,
  obv10d: null,
  obv20d: null,
  buyLgAmount: null,
  buyMdAmount: null,
  buySmAmount: null,
}

describe('createASharesIndexColumnDefs', () => {
  it('返回的列定义包含 count 列和 action 列（传入 onJumpToMembers 时）', () => {
    const onJumpToMembers = vi.fn()
    const cols = createASharesIndexColumnDefs({ onJumpToMembers })
    const keys = cols.map((c) => c.key)
    expect(keys).toContain('count')
    expect(keys).toContain('action')
  })

  it('未传入 onJumpToMembers 时不包含 action 列', () => {
    const cols = createASharesIndexColumnDefs()
    const keys = cols.map((c) => c.key)
    expect(keys).toContain('count')
    expect(keys).not.toContain('action')
  })

  it('返回的列定义包含资金流列', () => {
    const cols = createASharesIndexColumnDefs()
    const keys = cols.map((c) => c.key)
    expect(keys).toContain('net_amount')
    expect(keys).toContain('net_amount_5d')
    expect(keys).toContain('net_amount_10d')
    expect(keys).toContain('net_amount_20d')
    expect(keys).toContain('buy_lg_amount')
    expect(keys).toContain('buy_md_amount')
    expect(keys).toContain('buy_sm_amount')
  })

  it('资金流列默认隐藏', () => {
    const cols = createASharesIndexColumnDefs()
    const moneyFlowKeys = [
      'net_amount',
      'net_amount_5d',
      'net_amount_10d',
      'net_amount_20d',
      'buy_lg_amount',
      'buy_md_amount',
      'buy_sm_amount',
    ]
    for (const key of moneyFlowKeys) {
      const col = cols.find((c) => c.key === key)!
      expect(col.defaultVisible).toBe(false)
    }
  })
  it('count 列对 null 值渲染为 "-"', () => {
    const cols = createASharesIndexColumnDefs()
    const countCol = cols.find((c) => c.key === 'count')!
    expect(renderText(countCol.render({ ...baseRow, count: null }))).toBe('-')
  })

  it('count 列对数字值渲染为字符串', () => {
    const cols = createASharesIndexColumnDefs()
    const countCol = cols.find((c) => c.key === 'count')!
    expect(renderText(countCol.render({ ...baseRow, count: 50 }))).toBe('50')
    expect(renderText(countCol.render({ ...baseRow, count: 0 }))).toBe('0')
  })

  it('action 列点击时触发 onJumpToMembers 回调', () => {
    const onJumpToMembers = vi.fn()
    const cols = createASharesIndexColumnDefs({ onJumpToMembers })
    const actionCol = cols.find((c) => c.key === 'action')!
    const vnode = actionCol.render(baseRow)

    expect(isVNode(vnode)).toBe(true)
    // NButton 的 onClick 在 props 中
    const props = (vnode as { props?: Record<string, unknown> }).props
    expect(props).toBeDefined()
    expect(typeof props!.onClick).toBe('function')

    // 模拟点击
    ;(props!.onClick as () => void)()
    expect(onJumpToMembers).toHaveBeenCalledTimes(1)
    expect(onJumpToMembers).toHaveBeenCalledWith(baseRow)
  })
})

describe('OBV 列：正负着色 + 千元→亿', () => {
  function renderColor(node: unknown): string | undefined {
    if (!isVNode(node)) return undefined
    const style = (node as { props?: { style?: { color?: string } } }).props?.style
    return style?.color
  }

  const cols = createASharesIndexColumnDefs()
  const obv5dCol = cols.find((c) => c.key === 'obv5d')!

  it('正值（千元口径）渲染为绿色且按亿换算', () => {
    const node = obv5dCol.render({ ...baseRow, obv5d: 500000000 })
    expect(renderText(node)).toBe('5000.00 亿')
    expect(renderColor(node)).toBe(colors.success.DEFAULT)
  })

  it('负值渲染为红色', () => {
    const node = obv5dCol.render({ ...baseRow, obv5d: -300000000 })
    expect(renderText(node)).toBe('-3000.00 亿')
    expect(renderColor(node)).toBe(colors.error.DEFAULT)
  })

  it('0 值不着色', () => {
    const node = obv5dCol.render({ ...baseRow, obv5d: 0 })
    expect(renderText(node)).toBe('0.00 亿')
    expect(renderColor(node)).toBeUndefined()
  })

  it('null 渲染为 em dash 且不着色', () => {
    const node = obv5dCol.render({ ...baseRow, obv5d: null })
    expect(renderText(node)).toBe('-')
    expect(renderColor(node)).toBeUndefined()
  })
})

describe('净流入列：正负着色 + 万元口径', () => {
  /** 取 render 产物 VNode 的内联 color（无则 undefined） */
  function renderColor(node: unknown): string | undefined {
    if (!isVNode(node)) return undefined
    const style = (node as { props?: { style?: { color?: string } } }).props?.style
    return style?.color
  }

  const cols = createASharesIndexColumnDefs()
  const netCol = cols.find((c) => c.key === 'net_amount')!
  const lgCol = cols.find((c) => c.key === 'buy_lg_amount')!

  it('正值（万元口径，≥1亿）渲染为绿色且按亿换算', () => {
    // 关键回归：旧 formatAmount(50000) 会输出 "50000.00 万"，新 formatMoneyFlow 输出 "5.00 亿"
    const node = netCol.render({ ...baseRow, netAmount: 50000 })
    expect(renderText(node)).toBe('5.00 亿')
    expect(renderColor(node)).toBe(colors.success.DEFAULT)
  })

  it('正值（万级）渲染为绿色', () => {
    const node = netCol.render({ ...baseRow, netAmount: 320 })
    expect(renderText(node)).toBe('320.00 万')
    expect(renderColor(node)).toBe(colors.success.DEFAULT)
  })

  it('负值渲染为红色', () => {
    const node = netCol.render({ ...baseRow, netAmount: -30000 })
    expect(renderText(node)).toBe('-3.00 亿')
    expect(renderColor(node)).toBe(colors.error.DEFAULT)
  })

  it('0 值不着色', () => {
    const node = netCol.render({ ...baseRow, netAmount: 0 })
    expect(renderText(node)).toBe('0.00 万')
    expect(renderColor(node)).toBeUndefined()
  })

  it('null 渲染为 em dash 且不着色', () => {
    const node = netCol.render({ ...baseRow, netAmount: null })
    expect(renderText(node)).toBe('—')
    expect(renderColor(node)).toBeUndefined()
  })

  it('分单列（大单净流入）同样按口径与着色渲染', () => {
    const node = lgCol.render({ ...baseRow, buyLgAmount: -30000 })
    expect(renderText(node)).toBe('-3.00 亿')
    expect(renderColor(node)).toBe(colors.error.DEFAULT)
  })
})
