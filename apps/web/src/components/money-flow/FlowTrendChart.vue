<template>
  <div ref="chartRef" class="flow-trend-chart" />
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import { useTheme } from '../../composables/hooks/useTheme'
import type { BarChartRow } from './money-flow.types'

const props = defineProps<{
  rows: BarChartRow[]
}>()

const { echartsTheme } = useTheme()
const chartRef = ref<HTMLElement | null>(null)
let chartInstance: echarts.ECharts | null = null

function formatDateLabel(raw: string): string {
  if (raw.length === 8) return `${raw.slice(4, 6)}-${raw.slice(6, 8)}`
  return raw
}

function formatAmount(v: number): string {
  return `${v.toFixed(2)}亿`
}

function disposeChart() {
  chartInstance?.dispose()
  chartInstance = null
}

function handleResize() {
  chartInstance?.resize()
}

function renderChart() {
  const el = chartRef.value
  if (!el) return

  disposeChart()
  chartInstance = echarts.init(el)

  if (!props.rows.length) {
    chartInstance.setOption({
      ...echartsTheme.value,
      title: { text: '暂无数据', left: 'center', top: 'center', textStyle: { color: '#848E9C', fontSize: 14 } },
    })
    return
  }

  const dates = props.rows.map(r => formatDateLabel(r.label))
  const values = props.rows.map(r => r.value)

  chartInstance.setOption({
    ...echartsTheme.value,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter: (params: unknown) => {
        const items = params as { name: string; value: number; color: string; dataIndex: number }[]
        if (!items?.length) return ''
        const item = items[0]
        const rawLabel = props.rows[item.dataIndex]?.label ?? item.name
        return `<div style="font-size:13px">${rawLabel}<br/>
          <span style="display:inline-block;width:10px;height:10px;border-radius:2px;background:${item.color};margin-right:6px"></span>
          净流入: ${formatAmount(item.value)}</div>`
      },
    },
    grid: { left: 50, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category',
      data: dates,
      axisLabel: { rotate: 45, fontSize: 11 },
      axisTick: { alignWithLabel: true },
    },
    yAxis: {
      type: 'value',
      axisLabel: {
        formatter: (v: number) => `${v}亿`,
      },
      splitLine: { lineStyle: { type: 'dashed' } },
    },
    series: [{
      type: 'bar',
      data: values,
      barMaxWidth: 24,
      itemStyle: {
        color: (params: { value: number }) => params.value >= 0 ? '#f04747' : '#4caf8a',
        borderRadius: [2, 2, 0, 0],
      },
    }],
  })
}

onMounted(async () => {
  await nextTick()
  renderChart()
})

watch(() => props.rows, async () => {
  await nextTick()
  renderChart()
})

window.addEventListener('resize', handleResize)

onUnmounted(() => {
  disposeChart()
  window.removeEventListener('resize', handleResize)
})
</script>

<style scoped>
.flow-trend-chart {
  width: 100%;
  height: 360px;
  min-height: 240px;
}
</style>
