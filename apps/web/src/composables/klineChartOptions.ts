import type {
  BarSeriesOption,
  CandlestickSeriesOption,
  CustomSeriesOption,
  CustomSeriesRenderItemAPI,
  CustomSeriesRenderItemParams,
  EChartsOption,
  GraphicComponentOption,
  LineSeriesOption,
  MarkPointComponentOption,
  SeriesOption,
} from 'echarts'
import { colors } from '../styles/tokens'
import {
  ANCHOR_LINE_COLOR,
  BRICK_COLORS,
  CANDLE_COLORS,
  KDJ_COLORS,
  MA_COLORS,
  MACD_COLORS,
  TOOLTIP_STYLE,
  TRADE_COLORS,
} from './chartColors'
import type { KlineChartBar, TradeOnBar } from './useApi'

interface BuildKlineChartOptionsParams {
  data: KlineChartBar[]
  echartsTheme: Record<string, unknown>
  currentTs?: string
  sliderStart?: number
}

type BrickRangeDatum = [number, number, number]

const GRAPHIC_BG = {
  fill: colors.text.DEFAULT,
  backgroundColor: colors.surface.dark,
  padding: [4, 8],
  borderRadius: 3,
} as const

const GRAPHIC_MA = { id: 'ma-values', type: 'text' as const, left: '9%', top: '10%', z: 100 }
const GRAPHIC_KDJ = { id: 'kdj-values', type: 'text' as const, left: '9%', top: '52%', z: 100 }
const GRAPHIC_BRICK = { id: 'brick-values', type: 'text' as const, left: '9%', top: '84%', z: 100 }
const GRAPHIC_MACD = { id: 'macd-values', type: 'text' as const, left: '9%', top: '68%', z: 100 }

const ARROW_RICH = {
  arrowUp: { fill: CANDLE_COLORS.up, fontSize: 12 },
  arrowDown: { fill: CANDLE_COLORS.down, fontSize: 12 },
  arrowEq: { fill: CANDLE_COLORS.eq, fontSize: 12 },
} as const

const MARK_BASE_GAP = 0.008
const MARK_STACK_PX = 14

const fmt = (value: unknown, digits = 4) =>
  value === null || value === undefined || Number.isNaN(Number(value)) ? '-' : Number(value).toFixed(digits)

const fmtXg = (value: boolean | undefined) => (value ? '1' : '0')

const arrowRichTag = (key: 'up' | 'down' | 'eq'): string => {
  if (key === 'up') return 'arrowUp'
  if (key === 'down') return 'arrowDown'
  return 'arrowEq'
}

const arrow = (current: unknown, previous: unknown): { sym: string; key: 'up' | 'down' | 'eq' } => {
  const cur = Number(current)
  const prev = Number(previous)
  if (!Number.isFinite(cur) || !Number.isFinite(prev)) return { sym: '-', key: 'eq' }
  if (cur > prev) return { sym: '^', key: 'up' }
  if (cur < prev) return { sym: 'v', key: 'down' }
  return { sym: '-', key: 'eq' }
}

const buildMaText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  const prev = idx > 0 && idx - 1 < data.length ? data[idx - 1] : undefined
  const keys = ['MA5', 'MA30', 'MA60', 'MA120', 'MA240'] as const
  const rich: Record<string, unknown> = { ...ARROW_RICH }
  keys.forEach((key) => {
    rich[key.toLowerCase()] = { fill: MA_COLORS[key], fontSize: 12 }
  })
  if (!row) return { text: '', rich, ...GRAPHIC_BG }
  const text = keys
    .map((key) => {
      const state = arrow(row[key], prev?.[key])
      return `${key}: {${key.toLowerCase()}|${fmt(row[key])}}{${arrowRichTag(state.key)}|${state.sym}}`
    })
    .join('  ')
  return { text, rich, ...GRAPHIC_BG }
}

const buildKdjText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  const prev = idx > 0 && idx - 1 < data.length ? data[idx - 1] : undefined
  const keys = ['KDJ.K', 'KDJ.D', 'KDJ.J'] as const
  const labels: Record<string, string> = { 'KDJ.K': 'K', 'KDJ.D': 'D', 'KDJ.J': 'J' }
  const tags: Record<string, string> = { 'KDJ.K': 'k', 'KDJ.D': 'd', 'KDJ.J': 'j' }
  const rich: Record<string, unknown> = { ...ARROW_RICH }
  keys.forEach((key) => {
    rich[tags[key]] = { fill: KDJ_COLORS[key], fontSize: 12 }
  })
  if (!row) return { text: '', rich, ...GRAPHIC_BG }
  const text = keys
    .map((key) => {
      const state = arrow(row[key], prev?.[key])
      return `${labels[key]}: {${tags[key]}|${fmt(row[key], 2)}}{${arrowRichTag(state.key)}|${state.sym}}`
    })
    .join('  ')
  return { text, rich, ...GRAPHIC_BG }
}

const buildBrickText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  if (!row?.brickChart) return { text: '', rich: {}, ...GRAPHIC_BG }
  return {
    text: `XG: {xg|${fmtXg(row.brickChart.xg)}}  DELTA: {delta|${fmt(row.brickChart.delta, 2)}}  BRICK: {brick|${fmt(row.brickChart.brick, 2)}}`,
    rich: {
      xg: { fill: BRICK_COLORS.xg, fontSize: 12, fontWeight: 'bold' },
      delta: { fill: BRICK_COLORS.delta, fontSize: 12 },
      brick: { fill: BRICK_COLORS.brickUp, fontSize: 12 },
    },
    ...GRAPHIC_BG,
  }
}

const buildMacdText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  const prev = idx > 0 && idx - 1 < data.length ? data[idx - 1] : undefined
  const rich: Record<string, unknown> = { ...ARROW_RICH }
  rich['dif'] = { fill: MACD_COLORS.DIF, fontSize: 12 }
  rich['dea'] = { fill: MACD_COLORS.DEA, fontSize: 12 }
  rich['macd'] = { fill: MACD_COLORS.macdUp, fontSize: 12 }
  if (!row) return { text: '', rich, ...GRAPHIC_BG }
  const difState = arrow(row.DIF, prev?.DIF)
  const deaState = arrow(row.DEA, prev?.DEA)
  const macdState = arrow(row.MACD, prev?.MACD)
  const text = `DIF: {dif|${fmt(row.DIF, 4)}}{${arrowRichTag(difState.key)}|${difState.sym}}  DEA: {dea|${fmt(row.DEA, 4)}}{${arrowRichTag(deaState.key)}|${deaState.sym}}  MACD: {macd|${fmt(row.MACD, 4)}}{${arrowRichTag(macdState.key)}|${macdState.sym}}`
  return { text, rich, ...GRAPHIC_BG }
}

const escapeHtml = (text: string) =>
  text
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

const reasonLinesToHtml = (reason: string, lineStyle: string) =>
  reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<div style="${lineStyle}">${escapeHtml(line)}</div>`)
    .join('')

const buildTradesHtml = (trades: TradeOnBar[]): string => {
  if (!trades.length) return ''
  const detailStyle = 'padding-left:12px;margin-top:2px'
  const reasonLineStyle = `${detailStyle};color:${TOOLTIP_STYLE.dimText}`
  const fmtPnl = (value: number) => (value > 0 ? `+${value.toFixed(2)}` : value.toFixed(2))
  const lines = trades.map((trade) => {
    if (trade.type === 'entry') {
      return `<div style="color:${TRADE_COLORS.entry};margin-top:4px">
        <div>Entry</div>
        ${reasonLinesToHtml(trade.reason, reasonLineStyle)}
        <div style="${detailStyle}">Price: ${fmt(trade.price, 4)}</div>
        <div style="${detailStyle}">Shares: ${trade.shares}</div>
      </div>`
    }
    const rawPnl = Number(trade.pnl)
    const pnl = Number.isFinite(rawPnl) ? rawPnl : 0
    const pnlColor = pnl > 0 ? TRADE_COLORS.entry : pnl < 0 ? TRADE_COLORS.exit : CANDLE_COLORS.eq
    const exitReason = trade.isHalf ? `${trade.reason}\nPartial` : trade.reason
    return `<div style="color:${TRADE_COLORS.exit};margin-top:4px">
      <div>Exit</div>
      ${reasonLinesToHtml(exitReason, reasonLineStyle)}
      <div style="${detailStyle}">Price: ${fmt(trade.price, 4)}</div>
      <div style="${detailStyle}">PnL: <span style="color:${pnlColor}">${fmtPnl(pnl)}</span></div>
    </div>`
  })
  return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${TOOLTIP_STYLE.divider}">${lines.join('')}</div>`
}

const buildMarkPoints = (data: KlineChartBar[], currentTs: string) => {
  const points: MarkPointComponentOption['data'] = []
  for (const bar of data) {
    const trades = bar.trades
    if (!trades?.length) continue
    const isCurrentBar = bar.open_time === currentTs
    const low = Number(bar.low)
    if (!Number.isFinite(low) || low <= 0) continue
    const y0 = low * (1 - MARK_BASE_GAP)
    trades.forEach((trade, index) => {
      const isEntry = trade.type === 'entry'
      const color = isEntry
        ? isCurrentBar
          ? TRADE_COLORS.entry
          : TRADE_COLORS.entryDim
        : isCurrentBar
          ? TRADE_COLORS.exit
          : TRADE_COLORS.exitDim
      points.push({
        name: `${trade.type}-${bar.open_time}-${index}`,
        coord: [bar.open_time, y0],
        symbol: 'circle',
        symbolOffset: [0, index * MARK_STACK_PX],
        symbolSize: isCurrentBar ? 22 : 13,
        itemStyle: { color },
        label: {
          show: true,
          formatter: isEntry ? 'B' : 'S',
          color: colors.surface.DEFAULT,
          fontSize: isCurrentBar ? 13 : 8,
          fontWeight: isCurrentBar ? 'bold' : 'normal',
        },
      })
    })
  }
  return points
}

const buildTooltip = (row: KlineChartBar, idx: number, data: KlineChartBar[]) => {
  const open = Number(row.open)
  const high = Number(row.high)
  const low = Number(row.low)
  const close = Number(row.close)
  const prevClose = idx > 0 ? Number(data[idx - 1].close) : close
  const diff = close - prevClose
  const pct = prevClose ? (diff / prevClose) * 100 : 0
  const sign = diff >= 0 ? '+' : ''
  const color = diff >= 0 ? CANDLE_COLORS.up : CANDLE_COLORS.down
  const tradesHtml = row.trades?.length ? buildTradesHtml(row.trades) : ''
  return `<div style="font-size:12px;line-height:1.6;max-width:min(360px,85vw);word-break:break-word;overflow-wrap:break-word;box-sizing:border-box">
    <div style="margin-bottom:4px;color:${TOOLTIP_STYLE.muted}">${row.open_time ?? ''}</div>
    <div>Open: ${fmt(open, 4)}</div>
    <div>High: ${fmt(high, 4)}</div>
    <div>Low: ${fmt(low, 4)}</div>
    <div>Close: ${fmt(close, 4)}</div>
    <div style="color:${color}">Change: ${sign}${fmt(diff, 4)} (${sign}${pct.toFixed(2)}%)</div>
    ${tradesHtml}
  </div>`
}

const buildGraphics = (idx: number, data: KlineChartBar[]): GraphicComponentOption[] => [
  { ...GRAPHIC_MA, style: buildMaText(idx, data) },
  { ...GRAPHIC_KDJ, style: buildKdjText(idx, data) },
  { ...GRAPHIC_MACD, style: buildMacdText(idx, data) },
  { ...GRAPHIC_BRICK, style: buildBrickText(idx, data) },
]

export function buildKlineChartOption({
  data,
  echartsTheme,
  currentTs = '',
  sliderStart = 0,
}: BuildKlineChartOptionsParams): EChartsOption {
  const times = data.map((row) => row.open_time)
  const klines = data.map((row) => [row.open, row.close, row.low, row.high])
  const lastIdx = data.length - 1
  const deltaValues = data.map((row) => row.brickChart?.delta ?? 0)
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

  const deltaSeries: LineSeriesOption = {
    name: 'DELTA',
    type: 'line',
    xAxisIndex: 3,
    yAxisIndex: 4,
    data: deltaValues,
    showSymbol: false,
    lineStyle: { width: 1, color: BRICK_COLORS.delta },
    itemStyle: { color: BRICK_COLORS.delta },
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
    deltaSeries,
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
        data: ['BRICK', 'DELTA'],
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
      { scale: true, gridIndex: 3, position: 'right', splitLine: { show: false }, axisPointer: { label: { show: false } } },
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
