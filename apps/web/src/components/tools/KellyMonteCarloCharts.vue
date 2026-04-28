<template>
  <div class="charts-area">
    <div ref="equityChartRef" class="chart-box"></div>
    <div ref="distChartRef" class="chart-box"></div>
  </div>
</template>

<script setup lang="ts">
import { ref, watch, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts'
import type { SimPath, FinalDistribution } from './useKellySimulation'

const props = defineProps<{
  paths: SimPath[]
  distribution: FinalDistribution
  initialCapital: number
}>()

const equityChartRef = ref<HTMLDivElement>()
const distChartRef = ref<HTMLDivElement>()
let equityChart: echarts.ECharts | null = null
let distChart: echarts.ECharts | null = null

function initCharts() {
  if (equityChartRef.value) {
    equityChart = echarts.init(equityChartRef.value)
  }
  if (distChartRef.value) {
    distChart = echarts.init(distChartRef.value)
  }
}

function updateEquityChart() {
  if (!equityChart || props.paths.length === 0) return

  const series = props.paths.map((p, idx) => ({
    name: `Path ${idx}`,
    type: 'line',
    showSymbol: false,
    lineStyle: { width: 1, opacity: 0.3 },
    data: p.equityCurve,
    emphasis: { disabled: true },
  }))

  // 中位数曲线
  const medianCurve: number[] = []
  const tradeCount = props.paths[0]?.equityCurve.length ?? 0
  for (let t = 0; t < tradeCount; t++) {
    const values = props.paths.map((p) => p.equityCurve[t]).sort((a, b) => a - b)
    medianCurve.push(values[Math.floor(values.length / 2)])
  }

  series.push({
    name: '中位数',
    type: 'line',
    showSymbol: false,
    lineStyle: { width: 2.5, opacity: 1 },
    itemStyle: { color: '#f0a020' },
    data: medianCurve,
    z: 10,
  } as any)

  equityChart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 60, right: 20, top: 30, bottom: 30 },
    xAxis: {
      type: 'category',
      name: '交易笔数',
      nameTextStyle: { color: '#888' },
      axisLine: { lineStyle: { color: '#444' } },
      axisLabel: { color: '#888' },
      splitLine: { show: false },
    },
    yAxis: {
      type: 'log',
      name: '资金 ($)',
      logBase: 10,
      nameTextStyle: { color: '#888' },
      axisLine: { lineStyle: { color: '#444' } },
      axisLabel: {
        color: '#888',
        formatter: (v: number) => {
          if (v <= 0) return '0'
          const log10 = Math.log10(v)
          if (Math.abs(log10 - Math.round(log10)) < 0.01) {
            return '10^' + Math.round(log10)
          }
          return v.toFixed(0)
        },
      },
      splitLine: { lineStyle: { color: '#333' } },
      min: (value: any) => Math.max(value.min, 0.01),
    },
    series,
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1e1e1e',
      borderColor: '#444',
      textStyle: { color: '#ccc' },
      formatter: (params: any) => {
        const p = Array.isArray(params) ? params[0] : params
        if (!p) return ''
        return `交易 #${p.dataIndex}<br/>资金: $${p.value?.toFixed?.(2) ?? p.value}`
      },
    },
  }, true)
}

function updateDistChart() {
  if (!distChart || props.distribution.bins.length === 0) return

  const { bins, frequencies } = props.distribution

  distChart.setOption({
    backgroundColor: 'transparent',
    grid: { left: 60, right: 20, top: 30, bottom: 30 },
    xAxis: {
      type: 'value',
      name: '最终资金 ($)',
      nameTextStyle: { color: '#888' },
      axisLine: { lineStyle: { color: '#444' } },
      axisLabel: { color: '#888' },
      splitLine: { lineStyle: { color: '#333' } },
    },
    yAxis: {
      type: 'value',
      name: '频数',
      nameTextStyle: { color: '#888' },
      axisLine: { lineStyle: { color: '#444' } },
      axisLabel: { color: '#888' },
      splitLine: { lineStyle: { color: '#333' } },
    },
    series: [
      {
        type: 'bar',
        data: bins.map((b, i) => [b + (bins[1] - bins[0]) / 2, frequencies[i]]),
        itemStyle: { color: '#2080f0', opacity: 0.7 },
        barWidth: '95%',
      },
      {
        type: 'line',
        smooth: true,
        data: bins.map((b, i) => [b + (bins[1] - bins[0]) / 2, frequencies[i]]),
        lineStyle: { color: '#2080f0', width: 2 },
        symbol: 'none',
        areaStyle: { color: 'rgba(32,128,240,0.15)' },
      },
    ],
    tooltip: {
      trigger: 'axis',
      backgroundColor: '#1e1e1e',
      borderColor: '#444',
      textStyle: { color: '#ccc' },
    },
  }, true)
}

onMounted(() => {
  initCharts()
  updateEquityChart()
  updateDistChart()
})

onUnmounted(() => {
  equityChart?.dispose()
  distChart?.dispose()
})

watch(() => props.paths, updateEquityChart, { deep: true })
watch(() => props.distribution, updateDistChart, { deep: true })

// 响应式 resize
const handleResize = () => {
  equityChart?.resize()
  distChart?.resize()
}
window.addEventListener('resize', handleResize)
</script>

<style scoped>
.charts-area {
  display: grid;
  grid-template-columns: 2fr 1fr;
  gap: 14px;
  height: 400px;
}
.chart-box {
  background: var(--color-surface-elevated);
  border: 1px solid var(--color-border);
  border-radius: 10px;
  overflow: hidden;
}
@media (max-width: 1200px) {
  .charts-area {
    grid-template-columns: 1fr;
    height: auto;
  }
  .chart-box {
    height: 320px;
  }
}
</style>
