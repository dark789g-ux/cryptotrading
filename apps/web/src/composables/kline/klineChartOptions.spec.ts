import { describe, it, expect } from 'vitest'
import { buildKlineChartOption } from './klineChartOptions'
import { CANDLE_COLORS } from './chartColors'
import type { KlineChartBar, MoneyFlowBar } from '@/api'

// 构造最小可用 KlineChartBar 数组，open_time 用 Tushare 标准 YYYYMMDD
function makeBar(overrides: Partial<KlineChartBar> & { open_time: string }): KlineChartBar {
  return {
    open: 10,
    high: 11,
    low: 9,
    close: 10.5,
    volume: 1000,
    MA5: null,
    MA30: null,
    MA60: null,
    MA120: null,
    MA240: null,
    'KDJ.K': null,
    'KDJ.D': null,
    'KDJ.J': null,
    DIF: null,
    DEA: null,
    MACD: null,
    BBI: null,
    ...overrides,
  }
}

const baseData: KlineChartBar[] = [
  makeBar({ open_time: '20260510' }),
  makeBar({ open_time: '20260511' }),
  makeBar({ open_time: '20260512' }),
  makeBar({ open_time: '20260513' }),
]

const echartsTheme = {}

function arrify<T>(x: T | T[] | undefined): T[] {
  if (x == null) return []
  return Array.isArray(x) ? x : [x]
}

describe('buildKlineChartOption — 无 moneyFlow（snapshot 守护）', () => {
  const opt = buildKlineChartOption({ data: baseData, echartsTheme })

  it('series 数量与改造前一致（candle + 5MA + VOL + 3KDJ + DIF + DEA + 2MACD + BRICK = 15）', () => {
    expect(arrify(opt.series).length).toBe(15)
  })

  it('grid 数量 = 5', () => {
    expect(arrify(opt.grid).length).toBe(5)
  })

  it('xAxis 数量 = 5，最后一条显示 axisPointer label', () => {
    const xs = arrify(opt.xAxis) as any[]
    expect(xs.length).toBe(5)
    expect(xs[4].axisPointer.label.show).toBe(true)
    expect(xs[0].axisPointer.label.show).toBe(false)
  })

  it('yAxis 数量 = 5，无资金净流入名称', () => {
    const ys = arrify(opt.yAxis) as any[]
    expect(ys.length).toBe(5)
    ys.forEach((y) => expect(y.name).toBeUndefined())
  })

  it('legend 数量 = 5', () => {
    expect(arrify(opt.legend).length).toBe(5)
  })

  it('dataZoom.xAxisIndex 与改造前完全一致 [0,1,2,3,4]', () => {
    const dz = arrify(opt.dataZoom) as any[]
    expect(dz.length).toBe(2)
    expect(dz[0].xAxisIndex).toEqual([0, 1, 2, 3, 4])
    expect(dz[1].xAxisIndex).toEqual([0, 1, 2, 3, 4])
  })

  it('grid 配置 snapshot 锁定（改造前的精确 top/height）', () => {
    expect(arrify(opt.grid)).toEqual([
      { left: '8%', right: '8%', top: '10%', height: '33%' },
      { left: '8%', right: '8%', top: '48%', height: '8%' },
      { left: '8%', right: '8%', top: '60%', height: '9%' },
      { left: '8%', right: '8%', top: '73%', height: '9%' },
      { left: '8%', right: '8%', top: '86%', height: '6%' },
    ])
  })
})

describe('buildKlineChartOption — 有 moneyFlow', () => {
  it('全部命中：series / yAxis / grid 各多 1 条；dataZoom 包含 5', () => {
    const moneyFlow: MoneyFlowBar[] = baseData.map((row, i) => ({
      trade_date: row.open_time,
      net_amount: (i - 1) * 2.5, // -2.5, 0, 2.5, 5
    }))
    const opt = buildKlineChartOption({ data: baseData, echartsTheme, moneyFlow })

    expect(arrify(opt.series).length).toBe(16)
    expect(arrify(opt.grid).length).toBe(6)
    expect(arrify(opt.xAxis).length).toBe(6)
    expect(arrify(opt.yAxis).length).toBe(6)
    expect(arrify(opt.legend).length).toBe(6)

    const dz = arrify(opt.dataZoom) as any[]
    expect(dz[0].xAxisIndex).toEqual([0, 1, 2, 3, 4, 5])
    expect(dz[1].xAxisIndex).toEqual([0, 1, 2, 3, 4, 5])

    const ys = arrify(opt.yAxis) as any[]
    expect(ys[5].name).toBe('资金净流入(亿)')
    expect(ys[5].scale).toBe(true)
    expect(ys[5].gridIndex).toBe(5)

    const xs = arrify(opt.xAxis) as any[]
    expect(xs[5].gridIndex).toBe(5)
    expect(xs[5].axisPointer.label.show).toBe(true)
    // 改为第 6 条后，原先的 gridIndex=4 不再显示 axisPointer label
    expect(xs[4].axisPointer.label.show).toBe(false)

    const flowSeries = arrify(opt.series)[15] as any
    expect(flowSeries.type).toBe('bar')
    expect(flowSeries.xAxisIndex).toBe(5)
    expect(flowSeries.yAxisIndex).toBe(5)
    expect(flowSeries.data.length).toBe(baseData.length)
  })

  it('部分日期缺失：未命中位置 data[i] === null', () => {
    const moneyFlow: MoneyFlowBar[] = [
      { trade_date: '20260510', net_amount: 1.2 },
      // 20260511 缺失
      { trade_date: '20260512', net_amount: -0.8 },
      // 20260513 缺失
    ]
    const opt = buildKlineChartOption({ data: baseData, echartsTheme, moneyFlow })
    const seriesArr = arrify(opt.series)
    const flowSeries = seriesArr[seriesArr.length - 1] as any
    expect(flowSeries.data[0]).not.toBeNull()
    expect(flowSeries.data[0].value).toBe(1.2)
    expect(flowSeries.data[1]).toBeNull()
    expect(flowSeries.data[2]).not.toBeNull()
    expect(flowSeries.data[2].value).toBe(-0.8)
    expect(flowSeries.data[3]).toBeNull()
  })

  it('moneyFlow 顺序乱序：仍按 trade_date 与 KlineChartBar.open_time 对齐', () => {
    const moneyFlow: MoneyFlowBar[] = [
      { trade_date: '20260513', net_amount: 4 },
      { trade_date: '20260510', net_amount: 1 },
      { trade_date: '20260512', net_amount: 3 },
      { trade_date: '20260511', net_amount: 2 },
    ]
    const opt = buildKlineChartOption({ data: baseData, echartsTheme, moneyFlow })
    const seriesArr = arrify(opt.series)
    const flowSeries = seriesArr[seriesArr.length - 1] as any
    expect(flowSeries.data.map((d: any) => d?.value)).toEqual([1, 2, 3, 4])
  })

  it('正负染色：正值 → CANDLE_COLORS.up；负值 → CANDLE_COLORS.down；0 视为非负（up）', () => {
    const moneyFlow: MoneyFlowBar[] = [
      { trade_date: '20260510', net_amount: 5 },
      { trade_date: '20260511', net_amount: -3 },
      { trade_date: '20260512', net_amount: 0 },
      { trade_date: '20260513', net_amount: -0.01 },
    ]
    const opt = buildKlineChartOption({ data: baseData, echartsTheme, moneyFlow })
    const seriesArr = arrify(opt.series)
    const flowSeries = seriesArr[seriesArr.length - 1] as any
    expect(flowSeries.data[0].itemStyle.color).toBe(CANDLE_COLORS.up)
    expect(flowSeries.data[1].itemStyle.color).toBe(CANDLE_COLORS.down)
    expect(flowSeries.data[2].itemStyle.color).toBe(CANDLE_COLORS.up)
    expect(flowSeries.data[3].itemStyle.color).toBe(CANDLE_COLORS.down)
  })

  it('moneyFlow 为空数组：等价于未传，退回 5 副图布局', () => {
    const opt = buildKlineChartOption({ data: baseData, echartsTheme, moneyFlow: [] })
    expect(arrify(opt.grid).length).toBe(5)
    expect(arrify(opt.series).length).toBe(15)
    const dz = arrify(opt.dataZoom) as any[]
    expect(dz[0].xAxisIndex).toEqual([0, 1, 2, 3, 4])
  })
})
