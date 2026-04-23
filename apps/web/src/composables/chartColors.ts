// Binance Inspired 图表配色系统 — 国际惯例：绿涨红跌
export const MA_COLORS = {
  MA5:   '#F0B90B',
  MA30:  '#1EAEDB',
  MA60:  '#0ECB81',
  MA120: '#E8804C',
  MA240: '#C882E7',
} as const

export const KDJ_COLORS = {
  'KDJ.K': '#F0B90B',
  'KDJ.D': '#1EAEDB',
  'KDJ.J': '#0ECB81',
} as const

// K线：国际惯例 绿涨红跌
export const CANDLE_COLORS = {
  up:   '#0ECB81',
  down: '#F6465D',
  eq:   '#848E9C',
} as const

// 入/出场标记 — 国际惯例
export const TRADE_COLORS = {
  entry:    '#0ECB81',
  entryDim: 'rgba(14,203,129,0.45)',
  exit:     '#F6465D',
  exitDim:  'rgba(246,70,93,0.45)',
} as const

// 图表内嵌 tooltip（浅色主题）
export const TOOLTIP_STYLE = {
  bg:      '#222126',
  border:  '#3A3F48',
  muted:   '#848E9C',
  dimText: '#848E9C',
  divider: '#3A3F48',
} as const

// 参考线（锚点价格线等）
export const ANCHOR_LINE_COLOR = '#F0B90B'
