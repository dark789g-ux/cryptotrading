import type { GraphicComponentOption } from 'echarts'
import { colors } from '../../styles/tokens'
import { BRICK_COLORS, CANDLE_COLORS, KDJ_COLORS, MA_COLORS, MACD_COLORS } from './chartColors'
import { resolveKTopPct, resolveSubplotLayout } from './klineChartLayout'
import { ARROW_RICH, arrow, arrowRichTag, fmt, fmtCompact, fmtXg } from './klineChartUtils'
import type { SubplotConfig, SubplotKey } from './subplotConfig'
import type { KlineChartBar } from '@/api'

const GRAPHIC_BG = {
  fill: colors.text.DEFAULT,
  backgroundColor: colors.surface.dark,
  padding: [4, 8],
  borderRadius: 3,
} as const

const GRAPHIC_LEFT = '9%'
const GRAPHIC_Z = 100

const SUBPLOT_GRAPHIC_ID: Record<SubplotKey, string> = {
  VOL: 'volume-values',
  KDJ: 'kdj-values',
  MACD: 'macd-values',
  BRICK: 'brick-values',
  FLOW: 'flow-values', // 当前 FLOW 暂无悬浮文本，保留 id 以备后续扩展
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

const SUBPLOT_TEXT_BUILDERS: Record<
  SubplotKey,
  ((idx: number, data: KlineChartBar[]) => unknown) | null
> = {
  VOL: buildVolumeText,
  KDJ: buildKdjText,
  MACD: buildMacdText,
  BRICK: buildBrickText,
  FLOW: null, // FLOW 副图无悬浮文本（保持原 5 副图行为）
}

/**
 * 构造副图悬浮文本 graphics。
 *
 * @param subplots 当前可见副图（已按用户顺序解析），决定 MA / 各副图文本的纵向位置。
 *                 未传时按默认全开副图（VOL/KDJ/MACD/BRICK）布局，等价旧行为。
 */
export function buildGraphics(
  idx: number,
  data: KlineChartBar[],
  subplots: SubplotConfig[] = [],
): GraphicComponentOption[] {
  const kTopPct = resolveKTopPct(subplots)
  const result: GraphicComponentOption[] = [
    {
      id: 'ma-values',
      type: 'text',
      left: GRAPHIC_LEFT,
      top: `${kTopPct}%`,
      z: GRAPHIC_Z,
      style: buildMaText(idx, data) as Record<string, unknown>,
    },
  ]
  for (const slot of subplots) {
    const build = SUBPLOT_TEXT_BUILDERS[slot.key]
    if (!build) continue
    const layout = resolveSubplotLayout(slot.key, subplots)
    if (!layout) continue
    result.push({
      id: SUBPLOT_GRAPHIC_ID[slot.key],
      type: 'text',
      left: GRAPHIC_LEFT,
      top: `${layout.topPct}%`,
      z: GRAPHIC_Z,
      style: build(idx, data) as Record<string, unknown>,
    })
  }
  return result
}
