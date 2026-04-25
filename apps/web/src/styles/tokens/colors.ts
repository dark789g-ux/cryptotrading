/**
 * 颜色设计令牌（TypeScript）
 * 供 themeOverrides、组件逻辑、JS/TS 代码引用
 */

export const colors = {
  /** 主品牌色 — Binance Yellow */
  primary: {
    DEFAULT: '#F0B90B',
    hover: '#D0980B',
    pressed: '#D0980B',
    suppl: '#F0B90B',
  },

  /** 信息色 */
  info: {
    DEFAULT: '#848E9C',
    hover: '#686A6C',
    pressed: '#32313A',
  },

  /** 成功 — 绿涨 */
  success: {
    DEFAULT: '#0ECB81',
    hover: '#0DBA75',
    pressed: '#0BAF6E',
  },

  /** 警告 */
  warning: {
    DEFAULT: '#D0980B',
    hover: '#B8860B',
    pressed: '#A67C00',
  },

  /** 错误 — 红跌 */
  error: {
    DEFAULT: '#F6465D',
    hover: '#E03E4F',
    pressed: '#D13647',
  },

  /** 表面/背景 */
  surface: {
    DEFAULT: '#222126',
    elevated: '#2B2F36',
    dark: '#222126',
    darkCard: '#2B2F36',
  },

  /** 文字 */
  text: {
    DEFAULT: '#D0D4DC',
    secondary: '#848E9C',
    muted: '#686A6C',
    onDark: '#D0D4DC',
  },

  /** 边框 */
  border: {
    DEFAULT: '#3A3F48',
  },

  /** 图表背景高亮（副图区间背景） */
  chartBg: {
    green: 'rgba(14,203,129,0.15)',
    red: 'rgba(246,70,93,0.15)',
  },

  /** 其他辅助色 */
  black: '#000000',
  ink: '#1E2026',
  snow: '#F5F5F5',
  focusBlue: '#1EAEDB',
  gold: '#FFD000',
  lightGold: '#F8D12F',
  steel: '#686A6C',
  hoverDark: '#1A1A1A',
} as const

export type Colors = typeof colors
