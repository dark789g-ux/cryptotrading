import type {
  BarSeriesOption,
  CandlestickSeriesOption,
  CustomSeriesOption,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  EChartsOption,
  GraphicComponentOption,
  LineSeriesOption,
  SeriesOption,
} from 'echarts'
import { colors } from '../../styles/tokens'
import { ANCHOR_LINE_COLOR, BRICK_COLORS, CANDLE_COLORS, KDJ_COLORS, MA_COLORS, MACD_COLORS } from './chartColors'
import {
  buildDataZoom,
  buildGrid,
  buildLegend,
  buildXAxes,
  buildYAxes,
  resolveAxisIndex,
} from './klineChartLayout'
import { buildGraphics } from './klineChartOverlay'
import { buildMarkPoints, buildTooltip } from './klineChartTooltip'
import {
  DEFAULT_SUBPLOT_HEIGHT_PCT,
  type SubplotConfig,
  type SubplotKey,
} from './subplotConfig'
import type { KlineChartBar } from '@/api'

interface BuildKlineChartOptionsParams {
  data: KlineChartBar[]
  echartsTheme: Record<string, unknown>
  currentTs?: string
  sliderStart?: number
  /**
   * 用户偏好解析后的可见副图序列（已按顺序、含 heightPct）。
   * 未传时按"默认 5 副图（带/不带 FLOW 依据 data 是否含 moneyFlow）"回退，等价旧行为，
   * 保证 KlineChart.vue 现有调用与 spec 行为不变。
   */
  subplots?: SubplotConfig[]
}

const DEFAULT_SUBPLOT_ORDER_NO_FLOW: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK']
const DEFAULT_SUBPLOT_ORDER_WITH_FLOW: SubplotKey[] = ['VOL', 'KDJ', 'MACD', 'BRICK', 'FLOW']

/**
 * 兼容旧 5/6 副图布局：未显式传入 subplots 时，沿用"hasFlow=数据是否含 moneyFlow"的旧规则。
 * 重构前 5 副图布局的 K 高=33%、副图高 8/9/9/6%，与默认值（30%/8/8/8/6）略有差异；
 * 这里采用默认 height 表，保证与"有 flow"路径完全等价、视觉一致。
 */
function defaultSubplotsForData(data: KlineChartBar[]): SubplotConfig[] {
  const hasFlow = data.some((row) => row.moneyFlow != null)
  const keys = hasFlow ? DEFAULT_SUBPLOT_ORDER_WITH_FLOW : DEFAULT_SUBPLOT_ORDER_NO_FLOW
  return keys.map((k) => ({ key: k, visible: true, heightPct: DEFAULT_SUBPLOT_HEIGHT_PCT[k] }))
}

type BrickRangeDatum = [number, number, number]

const DATA_ZOOM_THROTTLE_MS = 80

function buildKdjMarkArea(data: KlineChartBar[]) {
  const greenZones: [number, number][] = []
  const redZones: [number, number][] = []
  let greenStart: number | null = null
  let redStart: number | null = null

  data.forEach((row, idx) => {
    const j = row['KDJ.J']
    if (j != null && j < 10) {
      if (greenStart === null) greenStart = idx
    } else {
      if (greenStart !== null) {
        greenZones.push([greenStart, idx - 1])
        greenStart = null
      }
    }
    if (j != null && j > 90) {
      if (redStart === null) redStart = idx
    } else {
      if (redStart !== null) {
        redZones.push([redStart, idx - 1])
        redStart = null
      }
    }
  })

  if (greenStart !== null) greenZones.push([greenStart, data.length - 1])
  if (redStart !== null) redZones.push([redStart, data.length - 1])

  return [
    ...greenZones.map(([start, end]) => [
      { xAxis: start, itemStyle: { color: colors.chartBg.green } },
      { xAxis: end },
    ]),
    ...redZones.map(([start, end]) => [
      { xAxis: start, itemStyle: { color: colors.chartBg.red } },
      { xAxis: end },
    ]),
  ] as [any, any][]
}

export function buildKlineChartOption({
  data,
  echartsTheme,
  currentTs = '',
  sliderStart = 0,
  subplots,
}: BuildKlineChartOptionsParams): EChartsOption {
  const resolvedSubplots: SubplotConfig[] = subplots ?? defaultSubplotsForData(data)
  // FLOW 副图渲染只取决于用户偏好（resolvedSubplots 是否包含 FLOW），不再依赖数据是否有 moneyFlow
  const flowAxis = resolveAxisIndex('FLOW', resolvedSubplots)
  const volAxis = resolveAxisIndex('VOL', resolvedSubplots)
  const kdjAxis = resolveAxisIndex('KDJ', resolvedSubplots)
  const macdAxis = resolveAxisIndex('MACD', resolvedSubplots)
  const brickAxis = resolveAxisIndex('BRICK', resolvedSubplots)
  const times = data.map((row) => row.open_time)
  const klines = data.map((row) => [row.open, row.close, row.low, row.high])
  const lastIdx = data.length - 1
  const brickRangeValues = data.flatMap<BrickRangeDatum>((row, idx) => {
    const current = row.brickChart?.brick
    const prev = idx > 0 ? data[idx - 1]?.brickChart?.brick : undefined
    if (current === undefined || prev === undefined) return []
    return [[idx, prev, current]]
  })

  const difValues = data.map((row) => row.DIF)
  const deaValues = data.map((row) => row.DEA)
  const volumeData: BarSeriesOption['data'] = data.map((row) => ({
    value: row.volume,
    itemStyle: {
      color: row.close >= row.open ? CANDLE_COLORS.up : CANDLE_COLORS.down,
    },
  }))
  const macdPositiveData = data.map((row, i) => {
    if (row.MACD == null || row.MACD <= 0) return null
    const prev = i > 0 ? data[i - 1].MACD : null
    const isRising = prev == null || row.MACD > prev
    return {
      value: row.MACD,
      itemStyle: isRising
        ? { color: MACD_COLORS.macdUp }
        : { color: 'transparent', borderColor: MACD_COLORS.macdUp, borderWidth: 1 },
    }
  })

  const macdNegativeData = data.map((row, i) => {
    if (row.MACD == null || row.MACD >= 0) return null
    const prev = i > 0 ? data[i - 1].MACD : null
    const isRising = prev == null || row.MACD > prev
    return {
      value: row.MACD,
      itemStyle: isRising
        ? { color: MACD_COLORS.macdDown }
        : { color: 'transparent', borderColor: MACD_COLORS.macdDown, borderWidth: 1 },
    }
  })

  const candleSeries: CandlestickSeriesOption = {
    name: 'K',
    type: 'candlestick',
    data: klines,
    itemStyle: {
      color: CANDLE_COLORS.up,
      color0: CANDLE_COLORS.down,
      borderColor: CANDLE_COLORS.up,
      borderColor0: CANDLE_COLORS.down,
    },
    markPoint: currentTs ? { data: buildMarkPoints(data, currentTs), silent: true } : undefined,
    markLine: currentTs
      ? {
          symbol: 'none',
          silent: true,
          data: [{ xAxis: currentTs }],
          lineStyle: { color: ANCHOR_LINE_COLOR, width: 1, type: 'dashed' },
          label: { show: false },
        }
      : undefined,
  }

  const maSeries: LineSeriesOption[] = (['MA5', 'MA30', 'MA60', 'MA120', 'MA240'] as const).map((key) => ({
    name: key,
    type: 'line',
    data: data.map((row) => row[key]),
    showSymbol: false,
    lineStyle: { width: 1, color: MA_COLORS[key] },
    itemStyle: { color: MA_COLORS[key] },
  }))

  const kdjRefLineStyle = { color: '#848E9C', type: 'dashed' as const }
  const kdjSeries: LineSeriesOption[] = !kdjAxis
    ? []
    : (['KDJ.K', 'KDJ.D', 'KDJ.J'] as const).map((key, idx) => ({
    name: key,
    type: 'line',
    xAxisIndex: kdjAxis.xAxisIndex,
    yAxisIndex: kdjAxis.yAxisIndex,
    data: data.map((row) => row[key]),
    showSymbol: false,
    lineStyle: { width: 1, color: KDJ_COLORS[key] },
    itemStyle: { color: KDJ_COLORS[key] },
    ...(idx === 0
      ? {
          markLine: {
            silent: true,
            symbol: 'none',
            data: [{ yAxis: 0 }, { yAxis: 10 }, { yAxis: 90 }],
            lineStyle: kdjRefLineStyle,
            label: { show: false },
          },
          markArea: {
            silent: true,
            label: { show: false },
            data: buildKdjMarkArea(data),
          },
        }
      : {}),
  }))

  const brickSeries: CustomSeriesOption | null = !brickAxis ? null : {
    name: 'BRICK',
    type: 'custom',
    xAxisIndex: brickAxis.xAxisIndex,
    yAxisIndex: brickAxis.yAxisIndex,
    clip: true,
    encode: { x: 0, y: [1, 2] },
    data: brickRangeValues,
    renderItem: (_params: CustomSeriesRenderItemParams, api: CustomSeriesRenderItemAPI) => {
      const xIdx = api.value(0)
      const start = api.value(1)
      const end = api.value(2)
      if (typeof start !== 'number' || typeof end !== 'number') return null
      const startPoint = api.coord([xIdx, start])
      const endPoint = api.coord([xIdx, end])
      const barWidth = Math.max(Number(api.size([1, 0])[0]) * 0.7, 1)
      const left = startPoint[0] - barWidth / 2
      const top = Math.min(startPoint[1], endPoint[1])
      const height = Math.max(Math.abs(endPoint[1] - startPoint[1]), 1)
      const isUp = end >= start
      return {
        type: 'rect',
        shape: { x: left, y: top, width: barWidth, height },
        style: api.style({
          fill: isUp ? BRICK_COLORS.brickUp : BRICK_COLORS.brickDown,
          stroke: isUp ? BRICK_COLORS.brickUp : BRICK_COLORS.brickDown,
        }),
      }
    },
  }

  const difSeries: LineSeriesOption | null = !macdAxis ? null : {
    name: 'DIF',
    type: 'line',
    xAxisIndex: macdAxis.xAxisIndex,
    yAxisIndex: macdAxis.yAxisIndex,
    data: difValues,
    showSymbol: false,
    lineStyle: { width: 1, color: MACD_COLORS.DIF },
    itemStyle: { color: MACD_COLORS.DIF },
    markLine: {
      silent: true,
      symbol: 'none',
      data: [{ yAxis: 0 }],
      lineStyle: { color: MACD_COLORS.zeroLine, type: 'dashed' },
      label: { show: false },
    },
  }

  const deaSeries: LineSeriesOption | null = !macdAxis ? null : {
    name: 'DEA',
    type: 'line',
    xAxisIndex: macdAxis.xAxisIndex,
    yAxisIndex: macdAxis.yAxisIndex,
    data: deaValues,
    showSymbol: false,
    lineStyle: { width: 1, color: MACD_COLORS.DEA },
    itemStyle: { color: MACD_COLORS.DEA },
    markLine: { silent: true, symbol: 'none', data: [], label: { show: false } },
  }

  const macdPositiveSeries: BarSeriesOption | null = !macdAxis ? null : {
    name: 'MACD',
    type: 'bar',
    xAxisIndex: macdAxis.xAxisIndex,
    yAxisIndex: macdAxis.yAxisIndex,
    data: macdPositiveData,
    barGap: '-100%',
  }

  const macdNegativeSeries: BarSeriesOption | null = !macdAxis ? null : {
    name: 'MACD',
    type: 'bar',
    xAxisIndex: macdAxis.xAxisIndex,
    yAxisIndex: macdAxis.yAxisIndex,
    data: macdNegativeData,
    barGap: '-100%',
  }

  const volumeSeries: BarSeriesOption | null = !volAxis ? null : {
    name: 'VOL',
    type: 'bar',
    xAxisIndex: volAxis.xAxisIndex,
    yAxisIndex: volAxis.yAxisIndex,
    data: volumeData,
    barMaxWidth: 12,
  }

  // 资金流副图：按 index 直接读 row.moneyFlow（合并已在 fetcher 层完成）。
  // 仅当用户偏好开启 FLOW 副图（flowAxis !== null）时构造，
  // 不再依据 data 是否含 moneyFlow 推断（hasFlow 语义已废弃）。
  let moneyFlowSeries: BarSeriesOption | null = null
  if (flowAxis) {
    const flowData: BarSeriesOption['data'] = data.map((row) => {
      const v = row.moneyFlow
      if (v == null) return null
      return {
        value: v,
        itemStyle: {
          color: v >= 0 ? CANDLE_COLORS.up : CANDLE_COLORS.down,
        },
      }
    })
    moneyFlowSeries = {
      name: 'FLOW',
      type: 'bar',
      xAxisIndex: flowAxis.xAxisIndex,
      yAxisIndex: flowAxis.yAxisIndex,
      data: flowData,
      barMaxWidth: 12,
    }
  }

  const series: SeriesOption[] = [
    candleSeries,
    ...maSeries,
    ...(volumeSeries ? [volumeSeries] : []),
    ...kdjSeries,
    ...(difSeries ? [difSeries] : []),
    ...(deaSeries ? [deaSeries] : []),
    ...(macdPositiveSeries ? [macdPositiveSeries] : []),
    ...(macdNegativeSeries ? [macdNegativeSeries] : []),
    ...(brickSeries ? [brickSeries] : []),
    ...(moneyFlowSeries ? [moneyFlowSeries] : []),
  ]

  return {
    ...echartsTheme,
    animation: false,
    animationDurationUpdate: 0,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      confine: true,
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : []
        const candle = arr.find((item) => (item as { seriesType?: string }).seriesType === 'candlestick')
        const first = candle ?? arr[0]
        if (!first) return ''
        const idx = (first as { dataIndex: number }).dataIndex
        const row = data[idx]
        if (!row) return ''
        return buildTooltip(row, idx, data)
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: buildLegend(resolvedSubplots),
    grid: buildGrid(resolvedSubplots),
    xAxis: buildXAxes(times, resolvedSubplots),
    yAxis: buildYAxes(resolvedSubplots),
    dataZoom: buildDataZoom(resolvedSubplots, sliderStart, DATA_ZOOM_THROTTLE_MS),
    graphic: buildGraphics(lastIdx, data, resolvedSubplots),
    series,
  }
}

/**
 * 兼容入口：旧调用点传 hasFlow:boolean；新调用点应改传 subplots:SubplotConfig[]。
 * 两种入参等价转换为内部副图序列后委托 buildGraphics。
 */
export function buildKlineChartGraphics(
  idx: number,
  data: KlineChartBar[],
  hasFlowOrSubplots: boolean | SubplotConfig[] = false,
): GraphicComponentOption[] {
  if (Array.isArray(hasFlowOrSubplots)) {
    return buildGraphics(idx, data, hasFlowOrSubplots)
  }
  // hasFlow:boolean → 默认副图序列（与 buildKlineChartOption 默认行为一致）
  const keys: SubplotKey[] = hasFlowOrSubplots
    ? DEFAULT_SUBPLOT_ORDER_WITH_FLOW
    : DEFAULT_SUBPLOT_ORDER_NO_FLOW
  const subs: SubplotConfig[] = keys.map((k) => ({
    key: k,
    visible: true,
    heightPct: DEFAULT_SUBPLOT_HEIGHT_PCT[k],
  }))
  return buildGraphics(idx, data, subs)
}
