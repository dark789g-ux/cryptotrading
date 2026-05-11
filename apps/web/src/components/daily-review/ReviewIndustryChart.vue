<template>
  <div ref="el" style="height: 320px"></div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'

const props = defineProps<{ items: { name: string; pctChg: number }[] }>()
const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

function render() {
  if (!chart) return
  chart.setOption({
    grid: { left: 80, right: 60, top: 10, bottom: 30 },
    xAxis: { type: 'value', axisLabel: { formatter: '{value}%' } },
    yAxis: { type: 'category', data: props.items.map(i => i.name).reverse() },
    series: [{
      type: 'bar',
      data: props.items.map(i => ({
        value: i.pctChg,
        itemStyle: { color: i.pctChg >= 0 ? '#e74c3c' : '#27ae60' },
      })).reverse(),
      label: { show: true, position: 'right', formatter: '{c}%' },
    }],
  })
}

onMounted(() => {
  chart = echarts.init(el.value!)
  render()
})
onUnmounted(() => chart?.dispose())
watch(() => props.items, render, { deep: true })
</script>
