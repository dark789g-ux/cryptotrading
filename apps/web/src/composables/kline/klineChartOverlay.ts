import type { GraphicComponentOption } from 'echarts'
import { colors } from '../../styles/tokens'
import { BRICK_COLORS, CANDLE_COLORS, KDJ_COLORS, MA_COLORS, MACD_COLORS } from './chartColors'
import { ARROW_RICH, arrow, arrowRichTag, fmt, fmtCompact, fmtXg } from './klineChartUtils'
import type { KlineChartBar } from '@/api'

const GRAPHIC_BG = {
  fill: colors.text.DEFAULT,
  backgroundColor: colors.surface.dark,
  padding: [4, 8],
  borderRadius: 3,
} as const

const GRAPHIC_MA = { id: 'ma-values', type: 'text' as const, left: '9%', top: '10%', z: 100 }
const GRAPHIC_VOLUME = { id: 'volume-values', type: 'text' as const, left: '9%', top: '48%', z: 100 }
const GRAPHIC_KDJ = { id: 'kdj-values', type: 'text' as const, left: '9%', top: '60%', z: 100 }
const GRAPHIC_MACD = { id: 'macd-values', type: 'text' as const, left: '9%', top: '73%', z: 100 }
const GRAPHIC_BRICK = { id: 'brick-values', type: 'text' as const, left: '9%', top: '86%', z: 100 }

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

const buildVolumeText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  if (!row) return { text: '', rich: {}, ...GRAPHIC_BG }
  const color = row.close >= row.open ? CANDLE_COLORS.up : CANDLE_COLORS.down
  return {
    text: `VOL: {vol|${fmtCompact(row.volume)}}`,
    rich: {
      vol: { fill: color, fontSize: 12, fontWeight: 'bold' },
    },
    ...GRAPHIC_BG,
  }
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

export function buildGraphics(idx: number, data: KlineChartBar[]): GraphicComponentOption[] {
  return [
    { ...GRAPHIC_MA, style: buildMaText(idx, data) },
    { ...GRAPHIC_VOLUME, style: buildVolumeText(idx, data) },
    { ...GRAPHIC_KDJ, style: buildKdjText(idx, data) },
    { ...GRAPHIC_MACD, style: buildMacdText(idx, data) },
    { ...GRAPHIC_BRICK, style: buildBrickText(idx, data) },
  ]
}
