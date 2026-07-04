<template>
  <div ref="el" class="nav-chart"></div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { RegimeBacktestDaily } from '@/api/modules/strategy/regimeEngine'
import { formatTradeDate } from '@/components/symbols/a-shares/aSharesFormatters'

const props = defineProps<{
  rows: RegimeBacktestDaily[]
  initialCapital: number
}>()

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null
let ro: ResizeObserver | null = null

interface NavPoint {
  date: string
  navUnit: number
  dailyRet: number
}

function buildPoints(): NavPoint[] {
  const base = props.initialCapital > 0 ? props.initialCapital : 1
  return props.rows.map((r) => ({
    date: r.tradeDate,
    navUnit: Number.isFinite(r.nav) ? r.nav / base : NaN,
    dailyRet: Number.isFinite(r.dailyRet) ? r.dailyRet : NaN,
  }))
}

function render() {
  if (!chart) return
  const points = buildPoints()
  const dates = points.map((p) => p.date)
  chart.setOption({
    grid: { left: 56, right: 20, top: 24, bottom: 36 },
    tooltip: {
      trigger: 'axis',
      formatter: (params: unknown) => {
        const arr = params as Array<{ dataIndex: number }>
        if (!arr.length) return ''
        const p = points[arr[0].dataIndex]
        if (!p) return ''
        const retPct = Number.isFinite(p.dailyRet) ? `${(p.dailyRet * 100).toFixed(2)}%` : '-'
        const nav = Number.isFinite(p.navUnit) ? p.navUnit.toFixed(4) : '-'
        return `${formatTradeDate(p.date)}<br/>净值：${nav}<br/>当日收益：${retPct}`
      },
    },
    xAxis: {
      type: 'category',
      data: dates,
      boundaryGap: false,
      axisLabel: {
        color: '#a0a4ab',
        formatter: (v: string) => formatTradeDate(v),
      },
    },
    yAxis: {
      type: 'value',
      scale: true,
      axisLabel: { color: '#a0a4ab' },
      splitLine: { lineStyle: { color: 'rgba(160,164,171,0.15)' } },
    },
    series: [
      {
        name: '净值',
        type: 'line',
        showSymbol: false,
        smooth: false,
        lineStyle: { width: 1.6, color: '#2080f0' },
        areaStyle: { color: 'rgba(32,128,240,0.08)' },
        data: points.map((p) => (Number.isFinite(p.navUnit) ? p.navUnit : null)),
      },
    ],
  })
}

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value)
  render()
  ro = new ResizeObserver(() => chart?.resize())
  ro.observe(el.value)
})

onUnmounted(() => {
  ro?.disconnect()
  chart?.dispose()
  chart = null
})

watch(
  () => props.rows,
  () => render(),
  { deep: true },
)
</script>

<style scoped>
.nav-chart {
  width: 100%;
  height: 320px;
}
</style>
