import type { MarkPointComponentOption } from 'echarts'
import { colors } from '../../styles/tokens'
import { CANDLE_COLORS, TOOLTIP_STYLE, TRADE_COLORS } from './chartColors'
import { fmt } from './klineChartUtils'
import type { KlineChartBar, TradeOnBar } from '../useApi'

const MARK_BASE_GAP = 0.008
const MARK_STACK_PX = 14

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

export function buildMarkPoints(data: KlineChartBar[], currentTs: string): MarkPointComponentOption['data'] {
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

export function buildTooltip(row: KlineChartBar, idx: number, data: KlineChartBar[]): string {
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
