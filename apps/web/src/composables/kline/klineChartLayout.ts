import type { EChartsOption } from 'echarts'
import { colors } from '../../styles/tokens'

// 资金流副图存在时的紧凑布局；副图缺失时沿用 5 副图旧布局（snapshot 守护）
const GRID_WITH_FLOW = {
  K:     { top: '6%',  height: '30%' },
  VOL:   { top: '38%', height: '8%'  },
  KDJ:   { top: '48%', height: '8%'  },
  MACD:  { top: '58%', height: '8%'  },
  BRICK: { top: '68%', height: '6%'  },
  FLOW:  { top: '76%', height: '10%' },
} as const

const LEGEND_TOP_WITH_FLOW = {
  K:     '4%',
  VOL:   '36%',
  KDJ:   '46%',
  MACD:  '56%',
  BRICK: '66%',
  FLOW:  '74%',
} as const

const legendBase = {
  orient: 'vertical' as const,
  right: 12,
  textStyle: { fontSize: 12, color: colors.text.DEFAULT },
  itemWidth: 14,
  itemHeight: 8,
}

export function buildLegend(hasFlow: boolean): EChartsOption['legend'] {
  if (hasFlow) {
    return [
      { ...legendBase, top: LEGEND_TOP_WITH_FLOW.K, data: ['K', 'MA5', 'MA30', 'MA60', 'MA120', 'MA240'] },
      { ...legendBase, top: LEGEND_TOP_WITH_FLOW.VOL, data: ['VOL'] },
      { ...legendBase, top: LEGEND_TOP_WITH_FLOW.KDJ, data: ['KDJ.K', 'KDJ.D', 'KDJ.J'] },
      { ...legendBase, top: LEGEND_TOP_WITH_FLOW.MACD, data: ['DIF', 'DEA', 'MACD'] },
      { ...legendBase, top: LEGEND_TOP_WITH_FLOW.BRICK, data: ['BRICK'] },
      { ...legendBase, top: LEGEND_TOP_WITH_FLOW.FLOW, data: ['FLOW'] },
    ]
  }
  return [
    { ...legendBase, top: '8%',  data: ['K', 'MA5', 'MA30', 'MA60', 'MA120', 'MA240'] },
    { ...legendBase, top: '48%', data: ['VOL'] },
    { ...legendBase, top: '60%', data: ['KDJ.K', 'KDJ.D', 'KDJ.J'] },
    { ...legendBase, top: '73%', data: ['DIF', 'DEA', 'MACD'] },
    { ...legendBase, top: '86%', data: ['BRICK'] },
  ]
}

export function buildGrid(hasFlow: boolean): EChartsOption['grid'] {
  if (hasFlow) {
    return [
      { left: '8%', right: '8%', top: GRID_WITH_FLOW.K.top, height: GRID_WITH_FLOW.K.height },
      { left: '8%', right: '8%', top: GRID_WITH_FLOW.VOL.top, height: GRID_WITH_FLOW.VOL.height },
      { left: '8%', right: '8%', top: GRID_WITH_FLOW.KDJ.top, height: GRID_WITH_FLOW.KDJ.height },
      { left: '8%', right: '8%', top: GRID_WITH_FLOW.MACD.top, height: GRID_WITH_FLOW.MACD.height },
      { left: '8%', right: '8%', top: GRID_WITH_FLOW.BRICK.top, height: GRID_WITH_FLOW.BRICK.height },
      { left: '8%', right: '8%', top: GRID_WITH_FLOW.FLOW.top, height: GRID_WITH_FLOW.FLOW.height },
    ]
  }
  return [
    { left: '8%', right: '8%', top: '10%', height: '33%' },
    { left: '8%', right: '8%', top: '48%', height: '8%' },
    { left: '8%', right: '8%', top: '60%', height: '9%' },
    { left: '8%', right: '8%', top: '73%', height: '9%' },
    { left: '8%', right: '8%', top: '86%', height: '6%' },
  ]
}

export function buildXAxes(times: string[], hasFlow: boolean): EChartsOption['xAxis'] {
  // 不带 moneyFlow：第 5 条（gridIndex=4，最底部 BRICK）显示 axisPointer label，对齐改造前行为
  // 带 moneyFlow：第 6 条（gridIndex=5，最底部 FLOW）显示 axisPointer label
  if (hasFlow) {
    return [
      { type: 'category', data: times, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 1, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 2, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 3, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 4, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 5, axisLabel: { show: false }, axisPointer: { label: { show: true } } },
    ]
  }
  return [
    { type: 'category', data: times, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
    { type: 'category', data: times, gridIndex: 1, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
    { type: 'category', data: times, gridIndex: 2, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
    { type: 'category', data: times, gridIndex: 3, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
    { type: 'category', data: times, gridIndex: 4, axisLabel: { show: false }, axisPointer: { label: { show: true } } },
  ]
}

export function buildYAxes(hasFlow: boolean): EChartsOption['yAxis'] {
  if (hasFlow) {
    return [
      { scale: true, splitLine: { show: false }, axisPointer: { label: { show: false } } },
      { scale: true, splitLine: { show: false }, gridIndex: 1, axisPointer: { label: { show: false } } },
      { scale: true, splitLine: { show: false }, gridIndex: 2, axisPointer: { label: { show: false } } },
      { scale: true, splitLine: { show: false }, gridIndex: 3, axisPointer: { label: { show: false } } },
      { scale: true, splitLine: { show: false }, gridIndex: 4, axisPointer: { label: { show: false } } },
      {
        scale: true,
        name: '资金净流入(亿)',
        nameTextStyle: { fontSize: 10, color: colors.text.DEFAULT },
        splitLine: { show: false },
        gridIndex: 5,
        axisPointer: { label: { show: false } },
      },
    ]
  }
  return [
    { scale: true, splitLine: { show: false }, axisPointer: { label: { show: false } } },
    { scale: true, splitLine: { show: false }, gridIndex: 1, axisPointer: { label: { show: false } } },
    { scale: true, splitLine: { show: false }, gridIndex: 2, axisPointer: { label: { show: false } } },
    { scale: true, splitLine: { show: false }, gridIndex: 3, axisPointer: { label: { show: false } } },
    { scale: true, splitLine: { show: false }, gridIndex: 4, axisPointer: { label: { show: false } } },
  ]
}

export function buildDataZoom(
  hasFlow: boolean,
  sliderStart: number,
  throttleMs: number,
): EChartsOption['dataZoom'] {
  const xAxisIndex = hasFlow ? [0, 1, 2, 3, 4, 5] : [0, 1, 2, 3, 4]
  return [
    {
      type: 'inside',
      xAxisIndex,
      start: sliderStart,
      end: 100,
      realtime: true,
      throttle: throttleMs,
      zoomOnMouseWheel: true,
      moveOnMouseWheel: false,
      moveOnMouseMove: true,
    },
    {
      type: 'slider',
      xAxisIndex,
      start: sliderStart,
      end: 100,
      realtime: true,
      throttle: throttleMs,
      bottom: 20,
      height: 22,
    },
  ]
}
