import { describe, it, expect } from 'vitest'
import { buildKlineChartOption } from './klineChartOptions'
import { CANDLE_COLORS } from './chartColors'
import { DEFAULT_SUBPLOT_HEIGHT_PCT, type SubplotConfig, type SubplotKey } from './subplotConfig'
import type { KlineChartBar } from '@/api'

function subplotsOf(keys: SubplotKey[]): SubplotConfig[] {
  return keys.map((key) => ({ key, visible: true, heightPct: DEFAULT_SUBPLOT_HEIGHT_PCT[key] }))
}

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

  it('grid 配置 snapshot 锁定（动态布局契约下：K=42% + 副图按 DEFAULT_SUBPLOT_HEIGHT_PCT）', () => {
    // 4 副图回退（无 moneyFlow）按 DEFAULT_SUBPLOT_HEIGHT_PCT 取 VOL/KDJ/MACD/BRICK=8/8/8/6
    // K.height = 100 - 6(K.top) - (8+8+8+6) - 4*2(gaps) - 14(dataZoom area) = 42
    expect(arrify(opt.grid)).toEqual([
      { left: '8%', right: '8%', top: '6%', height: '42%' },
      { left: '8%', right: '8%', top: '50%', height: '8%' },
      { left: '8%', right: '8%', top: '60%', height: '8%' },
      { left: '8%', right: '8%', top: '70%', height: '8%' },
      { left: '8%', right: '8%', top: '80%', height: '6%' },
    ])
  })
})

describe('buildKlineChartOption — 有 moneyFlow（按行内嵌）', () => {
  it('全部命中：series / yAxis / grid 各多 1 条；dataZoom 包含 5', () => {
    const data: KlineChartBar[] = baseData.map((row, i) => ({
      ...row,
      moneyFlow: (i - 1) * 2.5, // -2.5, 0, 2.5, 5
    }))
    const opt = buildKlineChartOption({ data, echartsTheme })

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
    expect(flowSeries.data.length).toBe(data.length)
  })

  it('部分日期缺失：未命中位置 data[i] === null', () => {
    const data: KlineChartBar[] = [
      { ...baseData[0], moneyFlow: 1.2 },
      { ...baseData[1], moneyFlow: null },
      { ...baseData[2], moneyFlow: -0.8 },
      { ...baseData[3], moneyFlow: null },
    ]
    const opt = buildKlineChartOption({ data, echartsTheme })
    const seriesArr = arrify(opt.series)
    const flowSeries = seriesArr[seriesArr.length - 1] as any
    expect(flowSeries.data[0]).not.toBeNull()
    expect(flowSeries.data[0].value).toBe(1.2)
    expect(flowSeries.data[1]).toBeNull()
    expect(flowSeries.data[2]).not.toBeNull()
    expect(flowSeries.data[2].value).toBe(-0.8)
    expect(flowSeries.data[3]).toBeNull()
  })

  it('moneyFlow 按 index 对齐（不再依赖外部 trade_date 排序）', () => {
    // 行内嵌契约下，flow 与 K 线天然按 index 对齐
    const data: KlineChartBar[] = [
      { ...baseData[0], moneyFlow: 1 },
      { ...baseData[1], moneyFlow: 2 },
      { ...baseData[2], moneyFlow: 3 },
      { ...baseData[3], moneyFlow: 4 },
    ]
    const opt = buildKlineChartOption({ data, echartsTheme })
    const seriesArr = arrify(opt.series)
    const flowSeries = seriesArr[seriesArr.length - 1] as any
    expect(flowSeries.data.map((d: any) => d?.value)).toEqual([1, 2, 3, 4])
  })

  it('正负染色：正值 → CANDLE_COLORS.up；负值 → CANDLE_COLORS.down；0 视为非负（up）', () => {
    const data: KlineChartBar[] = [
      { ...baseData[0], moneyFlow: 5 },
      { ...baseData[1], moneyFlow: -3 },
      { ...baseData[2], moneyFlow: 0 },
      { ...baseData[3], moneyFlow: -0.01 },
    ]
    const opt = buildKlineChartOption({ data, echartsTheme })
    const seriesArr = arrify(opt.series)
    const flowSeries = seriesArr[seriesArr.length - 1] as any
    expect(flowSeries.data[0].itemStyle.color).toBe(CANDLE_COLORS.up)
    expect(flowSeries.data[1].itemStyle.color).toBe(CANDLE_COLORS.down)
    expect(flowSeries.data[2].itemStyle.color).toBe(CANDLE_COLORS.up)
    expect(flowSeries.data[3].itemStyle.color).toBe(CANDLE_COLORS.down)
  })

  it('所有 moneyFlow 均为 null：等价于未启用副图，退回 5 副图布局', () => {
    const data: KlineChartBar[] = baseData.map(row => ({ ...row, moneyFlow: null }))
    const opt = buildKlineChartOption({ data, echartsTheme })
    expect(arrify(opt.grid).length).toBe(5)
    expect(arrify(opt.series).length).toBe(15)
    const dz = arrify(opt.dataZoom) as any[]
    expect(dz[0].xAxisIndex).toEqual([0, 1, 2, 3, 4])
  })
})

describe('buildKlineChartOption — 默认布局回归（不含 AMV 时与接入前一致）', () => {
  it('显式传 VOL/KDJ/MACD/BRICK（无 AMV）：grid=5、series=15，与 4 副图布局等价', () => {
    const subplots = subplotsOf(['VOL', 'KDJ', 'MACD', 'BRICK'])
    const opt = buildKlineChartOption({ data: baseData, echartsTheme, subplots })
    expect(arrify(opt.grid).length).toBe(5)
    expect(arrify(opt.series).length).toBe(15)
  })
})

describe('buildKlineChartOption — 活跃市值（0AMV / 0AMV_MACD）副图', () => {
  // 构造带 AMV 字段的数据：单线 + DIF/DEA/柱
  const amvData: KlineChartBar[] = baseData.map((row, i) => ({
    ...row,
    '0AMV': 1000 + i * 10,
    '0AMV.DIF': i - 1.5, // -1.5, -0.5, 0.5, 1.5
    '0AMV.DEA': 0,
    '0AMV.MACD': (i - 1.5) * 2, // -3, -1, 1, 3
  }))

  it('开启 0AMV 单线：多 1 grid/xAxis/yAxis/legend + 1 line series；yAxis 名为活跃市值', () => {
    const subplots = subplotsOf(['VOL', 'KDJ', 'MACD', 'BRICK', '0AMV'])
    const opt = buildKlineChartOption({ data: amvData, echartsTheme, subplots })

    expect(arrify(opt.grid).length).toBe(6)
    expect(arrify(opt.xAxis).length).toBe(6)
    expect(arrify(opt.yAxis).length).toBe(6)
    expect(arrify(opt.legend).length).toBe(6)

    const ys = arrify(opt.yAxis) as any[]
    expect(ys[5].name).toBe('活跃市值')

    const seriesArr = arrify(opt.series) as any[]
    const amvLine = seriesArr.find((s) => s.name === '0AMV')
    expect(amvLine).toBeTruthy()
    expect(amvLine.type).toBe('line')
    expect(amvLine.xAxisIndex).toBe(5)
    expect(amvLine.data).toEqual([1000, 1010, 1020, 1030])
  })

  it('开启 0AMV_MACD：柱 + DIF/DEA 双线；正负柱按符号分桶', () => {
    const subplots = subplotsOf(['VOL', 'KDJ', 'MACD', 'BRICK', '0AMV_MACD'])
    const opt = buildKlineChartOption({ data: amvData, echartsTheme, subplots })

    expect(arrify(opt.grid).length).toBe(6)

    const seriesArr = arrify(opt.series) as any[]
    const dif = seriesArr.find((s) => s.name === '0AMV.DIF')
    const dea = seriesArr.find((s) => s.name === '0AMV.DEA')
    const macdBars = seriesArr.filter((s) => s.name === '0AMV.MACD')
    expect(dif?.type).toBe('line')
    expect(dea?.type).toBe('line')
    expect(macdBars.length).toBe(2) // 正负各一条 bar
    expect(macdBars.every((s) => s.type === 'bar')).toBe(true)

    // 柱值 [-3,-1,1,3]：正桶仅保留 >0，负桶仅保留 <0
    const posBar = macdBars[0]
    const negBar = macdBars[1]
    expect(posBar.data.map((d: any) => d?.value ?? null)).toEqual([null, null, 1, 3])
    expect(negBar.data.map((d: any) => d?.value ?? null)).toEqual([-3, -1, null, null])
  })

  it('未开启 AMV 副图时不渲染 AMV series（即便数据含 0AMV 字段）', () => {
    const subplots = subplotsOf(['VOL', 'KDJ', 'MACD', 'BRICK'])
    const opt = buildKlineChartOption({ data: amvData, echartsTheme, subplots })
    const seriesArr = arrify(opt.series) as any[]
    expect(seriesArr.some((s) => String(s.name).startsWith('0AMV'))).toBe(false)
    expect(arrify(opt.grid).length).toBe(5)
  })

  it('AMV 字段缺日填 null：line/柱在缺位输出 null', () => {
    const partial: KlineChartBar[] = [
      { ...baseData[0], '0AMV': 100, '0AMV.MACD': 2 },
      { ...baseData[1], '0AMV': null, '0AMV.MACD': null },
      { ...baseData[2], '0AMV': 120, '0AMV.MACD': -1 },
      { ...baseData[3] },
    ]
    const subplots = subplotsOf(['VOL', 'KDJ', 'MACD', 'BRICK', '0AMV', '0AMV_MACD'])
    const opt = buildKlineChartOption({ data: partial, echartsTheme, subplots })
    const seriesArr = arrify(opt.series) as any[]
    const amvLine = seriesArr.find((s) => s.name === '0AMV')
    expect(amvLine.data).toEqual([100, null, 120, null])
  })
})
