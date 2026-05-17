<template>
  <div ref="el" class="score-series-chart"></div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { ScoreSeriesPoint } from '@/api/modules/quant'

const props = defineProps<{ points: ScoreSeriesPoint[] }>()
const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

function fmt(d: string) {
  if (d.length === 8) return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`
  return d
}

function render() {
  if (!chart) return
  const dates = props.points.map(p => fmt(p.trade_date))
  chart.setOption({
    grid: { left: 50, right: 50, top: 36, bottom: 30 },
    legend: { top: 0, textStyle: { color: '#a0a4ab' } },
    tooltip: { trigger: 'axis' },
    xAxis: { type: 'category', data: dates, axisLabel: { color: '#a0a4ab' } },
    yAxis: [
      { type: 'value', name: 'score', position: 'left', axisLabel: { color: '#a0a4ab' } },
      { type: 'value', name: 'rank', position: 'right', inverse: true, axisLabel: { color: '#a0a4ab' } },
    ],
    series: [
      {
        name: '评分',
        type: 'line',
        smooth: true,
        data: props.points.map(p => p.score),
      },
      {
        name: '排名',
        type: 'line',
        smooth: true,
        yAxisIndex: 1,
        data: props.points.map(p => p.rank_in_day),
        lineStyle: { type: 'dashed' },
      },
    ],
  })
}

onMounted(() => {
  if (!el.value) return
  chart = echarts.init(el.value)
  render()
})
onUnmounted(() => chart?.dispose())
watch(() => props.points, render, { deep: true })
</script>

<style scoped>
.score-series-chart {
  width: 100%;
  height: 320px;
}
</style>
