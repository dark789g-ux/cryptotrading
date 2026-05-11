<template>
  <div ref="el" style="height: 360px"></div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'

const props = defineProps<{
  topIn: { name: string; mainNetIn: number }[]
  topOut: { name: string; mainNetIn: number }[]
}>()
const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

function toHundredMillion(v: number) { return +(v / 1e8).toFixed(2) }

function render() {
  if (!chart) return
  const inItems = props.topIn.slice(0, 10)
  const outItems = props.topOut.slice(0, 10)
  const names = [...inItems.map(i => i.name), ...outItems.map(i => i.name)]
  chart.setOption({
    grid: { left: 80, right: 60, top: 10, bottom: 30 },
    xAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${v}亿` } },
    yAxis: { type: 'category', data: names },
    series: [
      {
        name: '净流入',
        type: 'bar',
        data: [
          ...inItems.map(i => ({ value: toHundredMillion(i.mainNetIn), itemStyle: { color: '#e74c3c' } })),
          ...outItems.map(i => ({ value: toHundredMillion(i.mainNetIn), itemStyle: { color: '#27ae60' } })),
        ],
        label: { show: true, position: 'right', formatter: (p: any) => `${p.value}亿` },
      },
    ],
  })
}

onMounted(() => { chart = echarts.init(el.value!); render() })
onUnmounted(() => chart?.dispose())
watch(() => [props.topIn, props.topOut], render, { deep: true })
</script>
