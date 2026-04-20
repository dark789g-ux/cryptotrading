// Ember Studio 图表配色系统
export const MA_COLORS = {
  MA5:   '#C2410C',
  MA30:  '#F59E0B',
  MA60:  '#16A34A',
  MA120: '#78716C',
  MA240: '#57534E',
} as const

export const KDJ_COLORS = {
  'KDJ.K': '#C2410C',
  'KDJ.D': '#F59E0B',
  'KDJ.J': '#16A34A',
} as const

// K线：中国惯例 红涨绿跌，映射 Ember 语义色
export const CANDLE_COLORS = {
  up:   '#DC2626',
  down: '#16A34A',
  eq:   '#78716C',
} as const

// 入/出场标记
export const TRADE_COLORS = {
  entry:    '#16A34A',
  entryDim: 'rgba(22,163,74,0.45)',
  exit:     '#DC2626',
  exitDim:  'rgba(220,38,38,0.45)',
} as const

// 图表内嵌 tooltip（浅色主题）
export const TOOLTIP_STYLE = {
  bg:      '#FAFAF9',
  border:  '#D6D3D1',
  muted:   '#78716C',
  dimText: '#A8A29E',
  divider: '#D6D3D1',
} as const

// 参考线（锚点价格线等）
export const ANCHOR_LINE_COLOR = '#F59E0B'
