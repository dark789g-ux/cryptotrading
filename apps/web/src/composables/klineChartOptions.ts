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
import { colors } from '../styles/tokens'
import { ANCHOR_LINE_COLOR, BRICK_COLORS, CANDLE_COLORS, KDJ_COLORS, MA_COLORS, MACD_COLORS } from './chartColors'
import { buildGraphics } from './klineChartOverlay'
import { buildMarkPoints, buildTooltip } from './klineChartTooltip'
import type { KlineChartBar } from './useApi'

interface BuildKlineChartOptionsParams {
  data: KlineChartBar[]
  echartsTheme: Record<string, unknown>
  currentTs?: string
  sliderStart?: number
}

type BrickRangeDatum = [number, number, number]

export function buildKlineChartOption({
  data,
  echartsTheme,
  currentTs = '',
  sliderStart = 0,
}: BuildKlineChartOptionsParams): EChartsOption {
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
  const macdRisingData = data.map((row, i) =>
    row.MACD != null && i > 0 && row.MACD > (data[i - 1].MACD ?? 0) ? row.MACD : null,
  )
  const macdFallingData = data.map((row, i) =>
    row.MACD != null && (i === 0 || row.MACD <= (data[i - 1].MACD ?? 0)) ? row.MACD : null,
  )

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
  const kdjSeries: LineSeriesOption[] = (['KDJ.K', 'KDJ.D', 'KDJ.J'] as const).map((key, idx) => ({
    name: key,
    type: 'line',
    xAxisIndex: 1,
    yAxisIndex: 1,
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
            data: [
              [
                { yAxis: Number.NEGATIVE_INFINITY, itemStyle: { color: 'rgba(14,203,129,0.08)' } },
                { yAxis: 10 },
              ],
              [
                { yAxis: 90, itemStyle: { color: 'rgba(246,70,93,0.08)' } },
                { yAxis: Number.POSITIVE_INFINITY },
              ],
            ],
          },
        }
      : {}),
  }))

  const brickSeries: CustomSeriesOption = {
    name: 'BRICK',
    type: 'custom',
    xAxisIndex: 3,
    yAxisIndex: 3,
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

  const difSeries: LineSeriesOption = {
    name: 'DIF',
    type: 'line',
    xAxisIndex: 2,
    yAxisIndex: 2,
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

  const deaSeries: LineSeriesOption = {
    name: 'DEA',
    type: 'line',
    xAxisIndex: 2,
    yAxisIndex: 2,
    data: deaValues,
    showSymbol: false,
    lineStyle: { width: 1, color: MACD_COLORS.DEA },
    itemStyle: { color: MACD_COLORS.DEA },
    markLine: { silent: true, symbol: 'none', data: [], label: { show: false } },
  }

  const macdRisingSeries: BarSeriesOption = {
    name: 'MACD',
    type: 'bar',
    xAxisIndex: 2,
    yAxisIndex: 2,
    data: macdRisingData,
    itemStyle: { color: MACD_COLORS.macdUp, borderColor: MACD_COLORS.macdUp },
  }

  const macdFallingSeries: BarSeriesOption = {
    name: 'MACD',
    type: 'bar',
    xAxisIndex: 2,
    yAxisIndex: 2,
    data: macdFallingData,
    itemStyle: {
      color: 'transparent',
      borderColor: MACD_COLORS.macdDown,
    },
  }

  const series: SeriesOption[] = [
    candleSeries,
    ...maSeries,
    ...kdjSeries,
    difSeries,
    deaSeries,
    macdRisingSeries,
    macdFallingSeries,
    brickSeries,
  ]

  return {
    ...echartsTheme,
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
    legend: [
      {
        orient: 'vertical',
        right: 12,
        top: '8%',
        data: ['K', 'MA5', 'MA30', 'MA60', 'MA120', 'MA240'],
        textStyle: { fontSize: 12, color: colors.text.DEFAULT },
        itemWidth: 14,
        itemHeight: 8,
      },
      {
        orient: 'vertical',
        right: 12,
        top: '52%',
        data: ['KDJ.K', 'KDJ.D', 'KDJ.J'],
        textStyle: { fontSize: 12, color: colors.text.DEFAULT },
        itemWidth: 14,
        itemHeight: 8,
      },
      {
        orient: 'vertical',
        right: 12,
        top: '68%',
        data: ['DIF', 'DEA', 'MACD'],
        textStyle: { fontSize: 12, color: colors.text.DEFAULT },
        itemWidth: 14,
        itemHeight: 8,
      },
      {
        orient: 'vertical',
        right: 12,
        top: '84%',
        data: ['BRICK'],
        textStyle: { fontSize: 12, color: colors.text.DEFAULT },
        itemWidth: 14,
        itemHeight: 8,
      },
    ],
    grid: [
      { left: '8%', right: '8%', top: '10%', height: '36%' },
      { left: '8%', right: '8%', top: '52%', height: '11%' },
      { left: '8%', right: '8%', top: '68%', height: '11%' },
      { left: '8%', right: '8%', top: '84%', height: '8%' },
    ],
    xAxis: [
      { type: 'category', data: times, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 1, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 2, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 3, axisLabel: { show: false }, axisPointer: { label: { show: true } } },
    ],
    yAxis: [
      { scale: true, splitLine: { show: false }, axisPointer: { label: { show: false } } },
      { scale: true, splitLine: { show: false }, gridIndex: 1, axisPointer: { label: { show: false } } },
      { scale: true, splitLine: { show: false }, gridIndex: 2, axisPointer: { label: { show: false } } },
      { scale: true, splitLine: { show: false }, gridIndex: 3, axisPointer: { label: { show: false } } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2, 3], start: sliderStart, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1, 2, 3], start: sliderStart, end: 100, bottom: 20, height: 22 },
    ],
    graphic: buildGraphics(lastIdx, data),
    series,
  }
}

export function buildKlineChartGraphics(idx: number, data: KlineChartBar[]): GraphicComponentOption[] {
  return buildGraphics(idx, data)
}
