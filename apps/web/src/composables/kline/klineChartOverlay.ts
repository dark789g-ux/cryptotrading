import type { GraphicComponentOption } from 'echarts'
import { colors } from '../../styles/tokens'
import { AMV_COLORS, BRICK_COLORS, KDJ_COLORS, MA_COLORS, MACD_COLORS, VWAP_COLORS } from './chartColors'
import { resolveKTopPct, resolveSubplotLayout } from './klineChartLayout'
import { ARROW_RICH, arrow, arrowRichTag, fmt, fmtCompact, fmtXg, resolveVolumeColor } from './klineChartUtils'
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
  // id 不得以数字开头（DOM id 合法性），故用 amv-* 而非 0amv-*
  '0AMV': 'amv-line-values',
  '0AMV_MACD': 'amv-macd-values',
}

const buildMaText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  const prev = idx > 0 && idx - 1 < data.length ? data[idx - 1] : undefined
  const keys = ['MA5', 'MA30', 'MA60', 'MA120', 'MA240'] as const
  const vwapKeys = ['VWAP5', 'VWAP10', 'VWAP20'] as const
  const rich: Record<string, unknown> = { ...ARROW_RICH }
  keys.forEach((key) => {
    rich[key.toLowerCase()] = { fill: MA_COLORS[key], fontSize: 12 }
  })
  vwapKeys.forEach((key) => {
    rich[key.toLowerCase()] = { fill: VWAP_COLORS[key], fontSize: 12 }
  })
  if (!row) return { text: '', rich, ...GRAPHIC_BG }
  const maParts = keys
    .map((key) => {
      const state = arrow(row[key], prev?.[key])
      return `${key}: {${key.toLowerCase()}|${fmt(row[key])}}{${arrowRichTag(state.key)}|${state.sym}}`
    })
  const vwapParts = vwapKeys
    .map((key) => {
      const state = arrow(row[key], prev?.[key])
      return `${key}: {${key.toLowerCase()}|${fmt(row[key], 2)}}{${arrowRichTag(state.key)}|${state.sym}}`
    })
  const text = [...maParts, ...vwapParts].join('  ')
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
  const prevClose = idx > 0 ? data[idx - 1].close : null
  const color = resolveVolumeColor(row, prevClose)
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

const buildAmvLineText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  const prev = idx > 0 && idx - 1 < data.length ? data[idx - 1] : undefined
  const rich: Record<string, unknown> = { ...ARROW_RICH }
  rich['amv'] = { fill: AMV_COLORS.line, fontSize: 12 }
  if (!row) return { text: '', rich, ...GRAPHIC_BG }
  const state = arrow(row['0AMV'], prev?.['0AMV'])
  const text = `0AMV: {amv|${fmtCompact(row['0AMV'] ?? null)}}{${arrowRichTag(state.key)}|${state.sym}}`
  return { text, rich, ...GRAPHIC_BG }
}

const buildAmvMacdText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  const prev = idx > 0 && idx - 1 < data.length ? data[idx - 1] : undefined
  const rich: Record<string, unknown> = { ...ARROW_RICH }
  rich['dif'] = { fill: AMV_COLORS.DIF, fontSize: 12 }
  rich['dea'] = { fill: AMV_COLORS.DEA, fontSize: 12 }
  rich['macd'] = { fill: AMV_COLORS.macdUp, fontSize: 12 }
  if (!row) return { text: '', rich, ...GRAPHIC_BG }
  const difState = arrow(row['0AMV.DIF'], prev?.['0AMV.DIF'])
  const deaState = arrow(row['0AMV.DEA'], prev?.['0AMV.DEA'])
  const macdState = arrow(row['0AMV.MACD'], prev?.['0AMV.MACD'])
  const text = `DIF: {dif|${fmt(row['0AMV.DIF'], 4)}}{${arrowRichTag(difState.key)}|${difState.sym}}  DEA: {dea|${fmt(row['0AMV.DEA'], 4)}}{${arrowRichTag(deaState.key)}|${deaState.sym}}  MACD: {macd|${fmt(row['0AMV.MACD'], 4)}}{${arrowRichTag(macdState.key)}|${macdState.sym}}`
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
  '0AMV': buildAmvLineText,
  '0AMV_MACD': buildAmvMacdText,
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
