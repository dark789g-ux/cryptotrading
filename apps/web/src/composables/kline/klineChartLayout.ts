import type { EChartsOption } from 'echarts'
import { colors } from '../../styles/tokens'
import { fmtCompact } from './klineChartUtils'
import type { SubplotConfig, SubplotKey } from './subplotConfig'

const SUB_AXIS_LABEL = { fontSize: 9, color: colors.text.DEFAULT } as const
const SUB_AXIS_SPLIT_NUMBER = 2
const VOL_LABEL_FORMATTER = (value: number) => fmtCompact(value, 0)

/**
 * 布局常量
 * - K 主图 top 固定 6%
 * - 副图之间（含 K → 第一副图）留 2% gap
 * - 底部 dataZoom 区域留 14%
 * - K 主图最小高度 20%
 *
 * 视觉对齐：当 5 个默认副图（VOL/KDJ/MACD/BRICK/FLOW = 8/8/8/6/10）全开时，
 * K.height = 100 - 6 - (8+8+8+6+10) - 5*2 - 14 = 30%，与重构前完全一致。
 */
const K_TOP_PCT = 6
const SUBPLOT_GAP_PCT = 2
const DATA_ZOOM_AREA_PCT = 14
const K_MIN_HEIGHT_PCT = 20
const GRID_LEFT = '8%'
const GRID_RIGHT = '8%'
const LEGEND_OFFSET_PCT = 2 // legend.top 比对应 grid.top 小 2pp（沿用旧规律）

const legendBase = {
  orient: 'vertical' as const,
  right: 12,
  textStyle: { fontSize: 12, color: colors.text.DEFAULT },
  itemWidth: 14,
  itemHeight: 8,
}

const SUBPLOT_LEGEND_DATA: Record<SubplotKey, string[]> = {
  VOL: ['VOL'],
  KDJ: ['KDJ.K', 'KDJ.D', 'KDJ.J'],
  MACD: ['DIF', 'DEA', 'MACD'],
  BRICK: ['BRICK'],
  FLOW: ['FLOW'],
  '0AMV': ['0AMV'],
  '0AMV_MACD': ['0AMV.DIF', '0AMV.DEA', '0AMV.MACD'],
}

interface ResolvedSlot {
  key: SubplotKey
  top: number
  height: number
  /** 0 表主图，1..n 表副图 */
  gridIndex: number
}

interface LayoutPlan {
  kTop: number
  kHeight: number
  subplots: ResolvedSlot[]
}

function planLayout(subplots: SubplotConfig[]): LayoutPlan {
  const visible = subplots // 调用方保证已可见已排序
  const subSum = visible.reduce((s, p) => s + p.heightPct, 0)
  const gapTotal = visible.length * SUBPLOT_GAP_PCT // K→第一副图 + 副图间 = N 个 gap
  let kHeight = 100 - K_TOP_PCT - subSum - gapTotal - DATA_ZOOM_AREA_PCT
  if (kHeight < K_MIN_HEIGHT_PCT) kHeight = K_MIN_HEIGHT_PCT

  let cursor = K_TOP_PCT + kHeight + SUBPLOT_GAP_PCT
  const slots: ResolvedSlot[] = visible.map((p, idx) => {
    const slot: ResolvedSlot = {
      key: p.key,
      top: cursor,
      height: p.heightPct,
      gridIndex: idx + 1,
    }
    cursor += p.heightPct + SUBPLOT_GAP_PCT
    return slot
  })

  return { kTop: K_TOP_PCT, kHeight, subplots: slots }
}

const pct = (v: number) => `${v}%`

export function buildLegend(subplots: SubplotConfig[]): EChartsOption['legend'] {
  const plan = planLayout(subplots)
  const result: NonNullable<EChartsOption['legend']>[] = [
    {
      ...legendBase,
      top: pct(Math.max(plan.kTop - LEGEND_OFFSET_PCT, 0)),
      data: ['K', 'MA5', 'MA30', 'MA60', 'MA120', 'MA240'],
    },
  ]
  for (const slot of plan.subplots) {
    result.push({
      ...legendBase,
      top: pct(Math.max(slot.top - LEGEND_OFFSET_PCT, 0)),
      data: SUBPLOT_LEGEND_DATA[slot.key],
    })
  }
  return result as EChartsOption['legend']
}

export function buildGrid(subplots: SubplotConfig[]): EChartsOption['grid'] {
  const plan = planLayout(subplots)
  const grids: NonNullable<EChartsOption['grid']>[] = [
    { left: GRID_LEFT, right: GRID_RIGHT, top: pct(plan.kTop), height: pct(plan.kHeight) },
  ]
  for (const slot of plan.subplots) {
    grids.push({
      left: GRID_LEFT,
      right: GRID_RIGHT,
      top: pct(slot.top),
      height: pct(slot.height),
    })
  }
  return grids as EChartsOption['grid']
}

export function buildXAxes(times: string[], subplots: SubplotConfig[]): EChartsOption['xAxis'] {
  const lastIdx = subplots.length // 最底部副图的 gridIndex（不含主图时 = 0，仅主图）
  const axes: any[] = [
    {
      type: 'category',
      data: times,
      axisLabel: { show: false },
      axisPointer: { label: { show: lastIdx === 0 } },
    },
  ]
  for (let i = 0; i < subplots.length; i++) {
    const gridIndex = i + 1
    const isLast = gridIndex === lastIdx
    axes.push({
      type: 'category',
      data: times,
      gridIndex,
      axisLabel: { show: false },
      axisPointer: { label: { show: isLast } },
    })
  }
  return axes as EChartsOption['xAxis']
}

export function buildYAxes(subplots: SubplotConfig[]): EChartsOption['yAxis'] {
  const yAxes: any[] = [
    { scale: true, splitLine: { show: false }, axisPointer: { label: { show: false } } },
  ]
  for (let i = 0; i < subplots.length; i++) {
    const slot = subplots[i]
    const gridIndex = i + 1
    const axisLabel =
      slot.key === 'VOL' ? { ...SUB_AXIS_LABEL, formatter: VOL_LABEL_FORMATTER } : SUB_AXIS_LABEL
    const base: Record<string, unknown> = {
      scale: true,
      splitLine: { show: false },
      gridIndex,
      splitNumber: SUB_AXIS_SPLIT_NUMBER,
      axisLabel,
      axisPointer: { label: { show: false } },
    }
    if (slot.key === 'FLOW') {
      base.name = '资金净流入(亿)'
      base.nameTextStyle = { fontSize: 10, color: colors.text.DEFAULT }
    }
    if (slot.key === '0AMV') {
      base.name = '活跃市值'
      base.nameTextStyle = { fontSize: 10, color: colors.text.DEFAULT }
    }
    yAxes.push(base)
  }
  return yAxes as EChartsOption['yAxis']
}

export function buildDataZoom(
  subplots: SubplotConfig[],
  sliderStart: number,
  throttleMs: number,
  zoom?: { start: number; end: number },
): EChartsOption['dataZoom'] {
  const xAxisIndex: number[] = [0]
  for (let i = 0; i < subplots.length; i++) xAxisIndex.push(i + 1)
  // 优先用记忆的水平缩放（用户拖动/滚轮后的 dataZoom 百分比），否则回退默认 sliderStart/100。
  const start = zoom?.start ?? sliderStart
  const end = zoom?.end ?? 100
  return [
    {
      type: 'inside',
      xAxisIndex,
      start,
      end,
      realtime: true,
      throttle: throttleMs,
      zoomOnMouseWheel: true,
      moveOnMouseWheel: false,
      moveOnMouseMove: true,
    },
    {
      type: 'slider',
      xAxisIndex,
      start,
      end,
      realtime: true,
      throttle: throttleMs,
      bottom: 20,
      height: 22,
    },
  ]
}

/**
 * 解析某副图的 ECharts 轴索引；副图不可见返回 null。
 * series / overlay graphic 用它定位。
 */
export function resolveAxisIndex(
  key: SubplotKey,
  subplots: SubplotConfig[],
): { gridIndex: number; xAxisIndex: number; yAxisIndex: number } | null {
  const i = subplots.findIndex((s) => s.key === key)
  if (i < 0) return null
  const idx = i + 1
  return { gridIndex: idx, xAxisIndex: idx, yAxisIndex: idx }
}

/**
 * 解析某副图的布局位置（top/height，单位：%），供 overlay graphic 文本贴位使用。
 */
export function resolveSubplotLayout(
  key: SubplotKey,
  subplots: SubplotConfig[],
): { topPct: number; heightPct: number } | null {
  const plan = planLayout(subplots)
  const slot = plan.subplots.find((s) => s.key === key)
  if (!slot) return null
  return { topPct: slot.top, heightPct: slot.height }
}

/** 主图 K 的 top%（overlay graphic 文本贴 K 主图顶部用） */
export function resolveKTopPct(subplots: SubplotConfig[]): number {
  return planLayout(subplots).kTop
}
