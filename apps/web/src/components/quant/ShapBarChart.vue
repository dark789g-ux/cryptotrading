<template>
  <div class="shap-bar-wrap">
    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state error">{{ error }}</div>
    <div v-else-if="items.length === 0" class="state">该 run 暂无 SHAP 数据</div>
    <div v-else ref="el" class="shap-chart" :style="{ height: chartHeight + 'px' }"></div>
  </div>
</template>

<script setup lang="ts">
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { ShapItem } from '@/api/modules/quant'

const props = withDefaults(
  defineProps<{
    items: ShapItem[]
    loading?: boolean
    error?: string | null
    topK?: number
  }>(),
  { loading: false, error: null, topK: 20 },
)

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

const topItems = computed<ShapItem[]>(() => {
  return [...props.items]
    .filter(x => x && Number.isFinite(x.importance))
    .sort((a, b) => Math.abs(b.importance) - Math.abs(a.importance))
    .slice(0, props.topK)
})

const chartHeight = computed(() => Math.max(240, topItems.value.length * 22 + 60))

function render() {
  if (!chart) return
  // ECharts 水平条形图，y 轴从下到上 → 反转数组让最高 importance 在最上
  const sorted = [...topItems.value].reverse()
  const labels = sorted.map(x => x.feature_id)
  const values = sorted.map(x => Number(x.importance.toFixed(6)))
  chart.setOption({
    grid: { left: 140, right: 30, top: 16, bottom: 30, containLabel: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      valueFormatter: (v: number) => v.toFixed(4),
    },
    xAxis: {
      type: 'value',
      axisLabel: { color: '#a0a4ab' },
      splitLine: { lineStyle: { color: 'rgba(160,164,171,0.1)' } },
    },
    yAxis: {
      type: 'category',
      data: labels,
      axisLabel: { color: '#a0a4ab', fontSize: 11 },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: 'rgba(160,164,171,0.3)' } },
    },
    series: [
      {
        type: 'bar',
        data: values,
        itemStyle: {
          color: (p: { value: number }) => (p.value >= 0 ? '#3a86ff' : '#ef4444'),
        },
        barMaxWidth: 16,
        label: {
          show: true,
          position: 'right',
          color: '#a0a4ab',
          fontSize: 11,
          formatter: (p: { value: number }) => p.value.toFixed(3),
        },
      },
    ],
  })
}

function resize() {
  chart?.resize()
}

onMounted(async () => {
  await nextTick()
  if (!el.value) return
  chart = echarts.init(el.value)
  render()
  window.addEventListener('resize', resize)
})

onUnmounted(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
  chart = null
})

watch(
  () => topItems.value,
  async () => {
    await nextTick()
    if (!chart && el.value) {
      chart = echarts.init(el.value)
    }
    chart?.resize()
    render()
  },
  { deep: true },
)
</script>

<style scoped>
.shap-bar-wrap {
  width: 100%;
  min-height: 240px;
}
.state {
  padding: 24px;
  text-align: center;
  color: var(--color-text-muted);
  font-size: 13px;
}
.state.error {
  color: var(--color-error);
}
.shap-chart {
  width: 100%;
}
</style>
