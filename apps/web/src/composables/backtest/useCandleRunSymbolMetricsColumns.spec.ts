import { describe, expect, it } from 'vitest'
import { isVNode } from 'vue'
import type { RunSymbolMetricRow } from '@/api'
import {
  BACKTEST_METRIC_KEYS,
  createBacktestMetricsColumnDefs,
} from './useCandleRunSymbolMetricsColumns'

/** 渲染产物归一为可断言文本：string 直接返回，VNode 取其 default slot / children 文本 */
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

function baseRow(overrides: Partial<RunSymbolMetricRow> = {}): RunSymbolMetricRow {
  return {
    symbol: '000001.SZ',
    dataStatus: 'ok',
    buyOnBar: false,
    sellOnBar: false,
    holdAtClose: false,
    close: 10,
    ma5: 11,
    ma30: 12,
    ma60: 13,
    kdjJ: -5.678,
    riskRewardRatio: 2.345,
    stopLossPct: 3.5,
    ...overrides,
  }
}

const noop = () => {}

describe('createBacktestMetricsColumnDefs', () => {
  it('BACKTEST_METRIC_KEYS = 6 个指标字段', () => {
    expect([...BACKTEST_METRIC_KEYS].sort()).toEqual(
      ['kdjJ', 'ma30', 'ma5', 'ma60', 'riskRewardRatio', 'stopLossPct'].sort(),
    )
  })

  it('产物含 symbol/dataStatus/barStatus/close + 6 指标列 + actions，顺序正确', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    expect(defs.map((d) => d.key)).toEqual([
      'symbol',
      'dataStatus',
      'barStatus',
      'close',
      'ma5',
      'ma30',
      'ma60',
      'kdjJ',
      'riskRewardRatio',
      'stopLossPct',
      'actions',
    ])
  })

  it('locked 列只有 symbol 与 actions（fixed），其余非 locked', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    const locked = defs.filter((d) => d.locked).map((d) => d.key)
    expect(locked).toEqual(['symbol', 'actions'])
    expect(defs.find((d) => d.key === 'symbol')!.fixed).toBe('left')
    expect(defs.find((d) => d.key === 'actions')!.fixed).toBe('right')
  })

  it('barStatus 列无 sorter；symbol/dataStatus/close + 指标列有 sorter', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    expect(defs.find((d) => d.key === 'barStatus')!.sorter).toBeUndefined()
    for (const key of ['symbol', 'dataStatus', 'close', 'ma5', 'kdjJ', 'stopLossPct']) {
      expect(defs.find((d) => d.key === key)!.sorter).toBe(true)
    }
  })

  it('全列 defaultVisible 维持现状（全可见）', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    expect(defs.every((d) => d.defaultVisible === true)).toBe(true)
  })

  it('指标列宽 100（覆盖 builder 默认 110）', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    for (const key of [...BACKTEST_METRIC_KEYS]) {
      expect(defs.find((d) => d.key === key)!.width).toBe(100)
    }
  })

  it('指标列 blankWhen：dataStatus="missing" → "-"，否则正常格式化', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    const ma5 = defs.find((d) => d.key === 'ma5')!
    const kdjJ = defs.find((d) => d.key === 'kdjJ')!
    const stop = defs.find((d) => d.key === 'stopLossPct')!

    expect(renderText(ma5.render(baseRow({ dataStatus: 'missing', ma5: 11 })))).toBe('-')
    expect(renderText(kdjJ.render(baseRow({ dataStatus: 'missing' })))).toBe('-')
    expect(renderText(stop.render(baseRow({ dataStatus: 'missing' })))).toBe('-')

    // dataStatus='ok' 走共享目录格式化（ma5 4 位 / kdjJ 2 位 / stop 2 位带 %）
    expect(renderText(ma5.render(baseRow({ ma5: 11 })))).toBe('11.0000')
    expect(renderText(kdjJ.render(baseRow({ kdjJ: -5.678 })))).toBe('-5.68')
    expect(renderText(stop.render(baseRow({ stopLossPct: 3.5 })))).toBe('3.50%')
  })

  it('指标列 null 值（dataStatus=ok）渲染 "-"', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    const stop = defs.find((d) => d.key === 'stopLossPct')!
    expect(renderText(stop.render(baseRow({ stopLossPct: null })))).toBe('-')
  })

  it('symbol 列渲染标的代码', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    const symbol = defs.find((d) => d.key === 'symbol')!
    expect(renderText(symbol.render(baseRow({ symbol: '600000.SH' })))).toBe('600000.SH')
  })

  it('close 列 dataStatus 守卫与 6 位格式化', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    const close = defs.find((d) => d.key === 'close')!
    expect(renderText(close.render(baseRow({ dataStatus: 'missing' })))).toBe('-')
    expect(renderText(close.render(baseRow({ close: 12.3 })))).toBe('12.300000')
  })

  it('dataStatus 列渲染状态标签（缺数据 / 正常）', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    const dataStatus = defs.find((d) => d.key === 'dataStatus')!
    expect(renderText(dataStatus.render(baseRow({ dataStatus: 'missing' })))).toBe('缺数据')
    expect(renderText(dataStatus.render(baseRow({ dataStatus: 'ok' })))).toBe('正常')
  })

  it('barStatus 列渲染买卖持有标签，三态全 false → "—"', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    const barStatus = defs.find((d) => d.key === 'barStatus')!
    expect(renderText(barStatus.render(baseRow()))).toBe('—')
    const node = barStatus.render(baseRow({ buyOnBar: true }))
    expect(isVNode(node)).toBe(true)
  })

  it('actions 列点击触发 onOpenKline，回传 symbol', () => {
    let opened = ''
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: (s) => (opened = s) })
    const actions = defs.find((d) => d.key === 'actions')!
    const node = actions.render(baseRow({ symbol: '300750.SZ' }))
    expect(isVNode(node)).toBe(true)
    const onClick = (node as { props?: { onClick?: () => void } }).props?.onClick
    onClick?.()
    expect(opened).toBe('300750.SZ')
  })

  it('指标列 title 由共享 descriptor 决定（KDJ.J / RR / Stop %）', () => {
    const defs = createBacktestMetricsColumnDefs({ onOpenKline: noop })
    expect(defs.find((d) => d.key === 'kdjJ')!.title).toBe('KDJ.J')
    expect(defs.find((d) => d.key === 'riskRewardRatio')!.title).toBe('RR')
    expect(defs.find((d) => d.key === 'stopLossPct')!.title).toBe('Stop %')
    // descKey 透传（抽屉 / 表头 ? 帮助图标依赖它）
    expect(defs.find((d) => d.key === 'kdjJ')!.descKey).toBe('kdj_j')
    expect(defs.find((d) => d.key === 'stopLossPct')!.descKey).toBe('stop_loss_pct')
  })
})
