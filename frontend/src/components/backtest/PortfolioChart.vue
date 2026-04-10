<template>
  <div ref="el" class="portfolio-chart"></div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted } from 'vue'
import * as echarts from 'echarts'

const props = defineProps({
  labels: { type: Array, default: () => [] },
  values: { type: Array, default: () => [] },
})

const el = ref(null)
let chart = null

function render() {
  if (!el.value) return
  if (!chart) chart = echarts.init(el.value)
  const initial = props.values[0] ?? 0
  chart.setOption({
    backgroundColor: '#fff',
    animation: false,
    tooltip: {
      trigger: 'axis',
      formatter(params) {
        const p = params[0]
        const val = p.value
        const ret = initial ? ((val - initial) / initial * 100).toFixed(2) : '0.00'
        return `${p.axisValue}<br/>净值: ${val?.toLocaleString('zh-CN', {maximumFractionDigits:2})}<br/>收益: ${ret}%`
      }
    },
    grid: { left: 80, right: 20, top: 20, bottom: 40 },
    xAxis: {
      type: 'category', data: props.labels,
      axisLabel: { fontSize: 10, color: '#888', rotate: 15 },
    },
    yAxis: {
      scale: true, axisLabel: { fontSize: 10, color: '#888',
        formatter: v => v >= 1000000 ? `${(v/1000000).toFixed(1)}M` : v.toLocaleString() }
    },
    series: [{
      type: 'line', data: props.values, symbol: 'none', smooth: false,
      lineStyle: { color: '#3498db', width: 2 },
      areaStyle: { color: { type: 'linear', x:0,y:0,x2:0,y2:1, colorStops:[
        {offset:0,color:'rgba(52,152,219,.25)'},{offset:1,color:'rgba(52,152,219,.02)'}
      ]}},
      markLine: { silent: true, symbol: 'none', lineStyle: { color: '#27ae60', type: 'dashed', width: 1 },
        data: [{ yAxis: initial, label: { show: true, formatter: '初始', fontSize: 10, color: '#27ae60' } }] }
    }],
    dataZoom: [{ type: 'inside' }, { type: 'slider', bottom: 0, height: 16 }],
  })
  chart.resize()
}

watch(() => [props.labels, props.values], render, { deep: true })
onMounted(render)

const ro = new ResizeObserver(() => chart?.resize())
onMounted(() => el.value && ro.observe(el.value))
onUnmounted(() => { ro.disconnect(); chart?.dispose() })
</script>

<style scoped>
.portfolio-chart { width: 100%; height: 220px; }
</style>
