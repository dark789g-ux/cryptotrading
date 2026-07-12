import type { CandlestickSeriesOption } from 'echarts'
import { colors } from '../../styles/tokens'
import type { KlineChartBar } from '@/api'

function buildKdjMarkArea(data: KlineChartBar[]) {
  const greenZones: [number, number][] = []
  const redZones: [number, number][] = []
  let greenStart: number | null = null
  let redStart: number | null = null

  data.forEach((row, idx) => {
    const j = row['KDJ.J']
    if (j != null && j < 10) {
      if (greenStart === null) greenStart = idx
    } else {
      if (greenStart !== null) {
        greenZones.push([greenStart, idx - 1])
        greenStart = null
      }
    }
    if (j != null && j > 90) {
      if (redStart === null) redStart = idx
    } else {
      if (redStart !== null) {
        redZones.push([redStart, idx - 1])
        redStart = null
      }
    }
  })

  if (greenStart !== null) greenZones.push([greenStart, data.length - 1])
  if (redStart !== null) redZones.push([redStart, data.length - 1])

  return [
    ...greenZones.map(([start, end]) => [
      { xAxis: start, itemStyle: { color: colors.chartBg.green } },
      { xAxis: end },
    ]),
    ...redZones.map(([start, end]) => [
      { xAxis: start, itemStyle: { color: colors.chartBg.red } },
      { xAxis: end },
    ]),
  ] as [any, any][]
}

const SUSPEND_BAND_COLOR = 'rgba(208, 152, 11, 0.08)'
const SUSPEND_BAND_LABEL_COLOR = 'rgba(208, 152, 11, 0.45)'

/** 停牌冻结区：从末根 K 右沿延伸至类目轴右端（需配合 xAxis.max 扩展） */
function buildSuspendMarkArea(
  lastIdx: number,
  axisMax: number,
): NonNullable<CandlestickSeriesOption['markArea']> {
  return {
    silent: true,
    itemStyle: { color: SUSPEND_BAND_COLOR, borderWidth: 0 },
    label: {
      show: true,
      position: 'inside',
      align: 'center',
      verticalAlign: 'middle',
      formatter: '停牌中',
      color: SUSPEND_BAND_LABEL_COLOR,
      fontSize: 11,
    },
    data: [
      [{ xAxis: lastIdx + 0.5 }, { xAxis: axisMax }],
    ] as NonNullable<CandlestickSeriesOption['markArea']>['data'],
  }
}

function resolveSuspendAxisMax(lastIdx: number, suspendBand: boolean): number | undefined {
  if (!suspendBand || lastIdx < 0) return undefined
  // 视觉延伸：约 15% 窗口宽度，至少 3 个类目槽
  const padding = Math.max(3, Math.round((lastIdx + 1) * 0.15))
  return lastIdx + padding
}

export { buildKdjMarkArea, buildSuspendMarkArea, resolveSuspendAxisMax }
