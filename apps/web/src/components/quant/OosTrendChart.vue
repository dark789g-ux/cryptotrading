<template>
  <div ref="el" class="oos-trend-chart"></div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'

/**
 * 最近 N 日 OOS 指标趋势小图
 * - x: 日期；多条线：NDCG@10 / IC / 扣成本年化（按 0..1 归一化展示则可直接共轴）
 */
interface Point {
  date: string
  ndcg10?: number | null
  ic?: number | null
  portfolio_annual_after_cost?: number | null
}

const props = defineProps<{ points: Point[] }>()
const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

function render() {
  if (!chart) return
  const dates = props.points.map(p => p.date)
  chart.setOption({
    grid: { left: 50, right: 20, top: 36, bottom: 30 },
    legend: { top: 0, textStyle: { color: '#a0a4ab' } },
    tooltip: { trigger: 'axis' },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: { color: '#a0a4ab' },
    },
    yAxis: { type: 'value', axisLabel: { color: '#a0a4ab' } },
    series: [
      {
        name: 'NDCG@10',
        type: 'line',
        data: props.points.map(p => p.ndcg10 ?? null),
        smooth: true,
        connectNulls: true,
      },
      {
        name: 'IC',
        type: 'line',
        data: props.points.map(p => p.ic ?? null),
        smooth: true,
        connectNulls: true,
      },
      {
        name: '扣成本年化',
        type: 'line',
        data: props.points.map(p => p.portfolio_annual_after_cost ?? null),
        smooth: true,
        connectNulls: true,
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
.oos-trend-chart {
  width: 100%;
  height: 240px;
}
</style>
