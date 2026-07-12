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
import {
  AMV_COLORS,
  ANCHOR_LINE_COLOR,
  BRICK_COLORS,
  CANDLE_COLORS,
  KDJ_COLORS,
  MA_COLORS,
  MACD_COLORS,
} from './chartColors'
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
import { resolveVolumeColor } from './klineChartUtils'
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
   * 记忆的水平缩放（dataZoom start/end 百分比，全局共享）。
   * 提供时覆盖 sliderStart/100 默认值，使切换股票后缩放保持。
   */
  zoom?: { start: number; end: number }
  /**
   * 用户偏好解析后的可见副图序列（已按顺序、含 heightPct）。
   * 未传时按"默认 5 副图（带/不带 FLOW 依据 data 是否含 moneyFlow）"回退，等价旧行为，
   * 保证 KlineChart.vue 现有调用与 spec 行为不变。
   */
  subplots?: SubplotConfig[]
  /** 当前停牌：主图末根 K 右沿至轴右端绘制半透明冻结区 */
  suspendBand?: boolean
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

/**
 * 构造 MACD/AMV-MACD 柱状数据的一侧（正或负）。
 * - sign='pos'：仅保留 >0 的柱；sign='neg'：仅保留 <0 的柱。
 * - 上涨实心、下跌空心描边（与原 MACD 副图视觉一致）。
 * 个股 MACD 与 AMV 的 MACD 共用此构造，避免四份重复。
 */
function buildMacdBarData(
  data: KlineChartBar[],
  valueOf: (row: KlineChartBar) => number | null | undefined,
  sign: 'pos' | 'neg',
  color: string,
): BarSeriesOption['data'] {
  return data.map((row, i) => {
    const v = valueOf(row)
    if (v == null) return null
    if (sign === 'pos' ? v <= 0 : v >= 0) return null
    const prev = i > 0 ? valueOf(data[i - 1]) : null
    const isRising = prev == null || v > prev
    return {
      value: v,
      itemStyle: isRising
        ? { color }
        : { color: 'transparent', borderColor: color, borderWidth: 1 },
    }
  })
}

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

const SUSPEND_BAND_COLOR = 'rgba(208, 152, 11, 0.08)'
const SUSPEND_BAND_LABEL_COLOR = 'rgba(208, 152, 11, 0.45)'

/** 停牌冻结区：从末根 K 右沿延伸至类目轴右端（需配合 xAxis.max 扩展） */
function buildSuspendMarkArea(
  lastIdx: number,
  axisMax: number,
): NonNullable<CandlestickSeriesOption['markArea']> {
  return {
    silent: true,
    itemStyle: { color: SUSPEND_BAND_COLOR, borderWidth: 0 },
    label: {
      show: true,
      position: 'inside',
      align: 'center',
      verticalAlign: 'middle',
      formatter: '停牌中',
      color: SUSPEND_BAND_LABEL_COLOR,
      fontSize: 11,
    },
    data: [
      [{ xAxis: lastIdx + 0.5 }, { xAxis: axisMax }],
    ] as NonNullable<CandlestickSeriesOption['markArea']>['data'],
  }
}

function resolveSuspendAxisMax(lastIdx: number, suspendBand: boolean): number | undefined {
  if (!suspendBand || lastIdx < 0) return undefined
  // 视觉延伸：约 15% 窗口宽度，至少 3 个类目槽
  const padding = Math.max(3, Math.round((lastIdx + 1) * 0.15))
  return lastIdx + padding
}

export function buildKlineChartOption({
  data,
  echartsTheme,
  currentTs = '',
  sliderStart = 0,
  zoom,
  subplots,
  suspendBand = false,
}: BuildKlineChartOptionsParams): EChartsOption {
  const resolvedSubplots: SubplotConfig[] = subplots ?? defaultSubplotsForData(data)
  // FLOW 副图渲染只取决于用户偏好（resolvedSubplots 是否包含 FLOW），不再依赖数据是否有 moneyFlow
  const flowAxis = resolveAxisIndex('FLOW', resolvedSubplots)
  const volAxis = resolveAxisIndex('VOL', resolvedSubplots)
  const kdjAxis = resolveAxisIndex('KDJ', resolvedSubplots)
  const macdAxis = resolveAxisIndex('MACD', resolvedSubplots)
  const brickAxis = resolveAxisIndex('BRICK', resolvedSubplots)
  const amvAxis = resolveAxisIndex('0AMV', resolvedSubplots)
  const amvMacdAxis = resolveAxisIndex('0AMV_MACD', resolvedSubplots)
  const times = data.map((row) => row.open_time)
  const klines = data.map((row) => [row.open, row.close, row.low, row.high])
  const lastIdx = data.length - 1
  const suspendAxisMax = resolveSuspendAxisMax(lastIdx, suspendBand)
  const brickRangeValues = data.flatMap<BrickRangeDatum>((row, idx) => {
    const current = row.brickChart?.brick
    const prev = idx > 0 ? data[idx - 1]?.brickChart?.brick : undefined
    if (current === undefined || prev === undefined) return []
    return [[idx, prev, current]]
  })

  const difValues = data.map((row) => row.DIF)
  const deaValues = data.map((row) => row.DEA)
  const volumeData: BarSeriesOption['data'] = data.map((row, idx) => ({
    value: row.volume,
    itemStyle: {
      color: resolveVolumeColor(row, idx > 0 ? data[idx - 1].close : null),
    },
  }))
  const macdPositiveData = buildMacdBarData(data, (row) => row.MACD, 'pos', MACD_COLORS.macdUp)
  const macdNegativeData = buildMacdBarData(data, (row) => row.MACD, 'neg', MACD_COLORS.macdDown)

  const amvLineValues = data.map((row) => row['0AMV'] ?? null)
  const amvDifValues = data.map((row) => row['0AMV.DIF'] ?? null)
  const amvDeaValues = data.map((row) => row['0AMV.DEA'] ?? null)
  const amvMacdPositiveData = buildMacdBarData(data, (row) => row['0AMV.MACD'], 'pos', AMV_COLORS.macdUp)
  const amvMacdNegativeData = buildMacdBarData(data, (row) => row['0AMV.MACD'], 'neg', AMV_COLORS.macdDown)

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
    ...(suspendBand && suspendAxisMax != null
      ? { markArea: buildSuspendMarkArea(lastIdx, suspendAxisMax) }
      : {}),
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

  // 活跃市值（AMV）单线副图：画 row['0AMV']（amvClose），仅当用户偏好开启时构造
  const amvLineSeries: LineSeriesOption | null = !amvAxis ? null : {
    name: '0AMV',
    type: 'line',
    xAxisIndex: amvAxis.xAxisIndex,
    yAxisIndex: amvAxis.yAxisIndex,
    data: amvLineValues,
    showSymbol: false,
    lineStyle: { width: 1, color: AMV_COLORS.line },
    itemStyle: { color: AMV_COLORS.line },
  }

  // 活跃市值的 MACD 副图：仿现有 MACD（柱 + DIF/DEA 双线）
  const amvDifSeries: LineSeriesOption | null = !amvMacdAxis ? null : {
    name: '0AMV.DIF',
    type: 'line',
    xAxisIndex: amvMacdAxis.xAxisIndex,
    yAxisIndex: amvMacdAxis.yAxisIndex,
    data: amvDifValues,
    showSymbol: false,
    lineStyle: { width: 1, color: AMV_COLORS.DIF },
    itemStyle: { color: AMV_COLORS.DIF },
    markLine: {
      silent: true,
      symbol: 'none',
      data: [{ yAxis: 0 }],
      lineStyle: { color: AMV_COLORS.zeroLine, type: 'dashed' },
      label: { show: false },
    },
  }

  const amvDeaSeries: LineSeriesOption | null = !amvMacdAxis ? null : {
    name: '0AMV.DEA',
    type: 'line',
    xAxisIndex: amvMacdAxis.xAxisIndex,
    yAxisIndex: amvMacdAxis.yAxisIndex,
    data: amvDeaValues,
    showSymbol: false,
    lineStyle: { width: 1, color: AMV_COLORS.DEA },
    itemStyle: { color: AMV_COLORS.DEA },
    markLine: { silent: true, symbol: 'none', data: [], label: { show: false } },
  }

  const amvMacdPositiveSeries: BarSeriesOption | null = !amvMacdAxis ? null : {
    name: '0AMV.MACD',
    type: 'bar',
    xAxisIndex: amvMacdAxis.xAxisIndex,
    yAxisIndex: amvMacdAxis.yAxisIndex,
    data: amvMacdPositiveData,
    barGap: '-100%',
  }

  const amvMacdNegativeSeries: BarSeriesOption | null = !amvMacdAxis ? null : {
    name: '0AMV.MACD',
    type: 'bar',
    xAxisIndex: amvMacdAxis.xAxisIndex,
    yAxisIndex: amvMacdAxis.yAxisIndex,
    data: amvMacdNegativeData,
    barGap: '-100%',
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
    ...(amvLineSeries ? [amvLineSeries] : []),
    ...(amvDifSeries ? [amvDifSeries] : []),
    ...(amvDeaSeries ? [amvDeaSeries] : []),
    ...(amvMacdPositiveSeries ? [amvMacdPositiveSeries] : []),
    ...(amvMacdNegativeSeries ? [amvMacdNegativeSeries] : []),
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
    xAxis: buildXAxes(times, resolvedSubplots, suspendAxisMax),
    yAxis: buildYAxes(resolvedSubplots),
    dataZoom: buildDataZoom(resolvedSubplots, sliderStart, DATA_ZOOM_THROTTLE_MS, zoom),
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
