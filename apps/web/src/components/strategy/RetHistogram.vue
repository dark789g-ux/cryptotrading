<template>
  <div class="ret-histogram-wrap">
    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state error">{{ error }}</div>
    <div v-else-if="data && data.bins.length === 0" class="state">该运行暂无样本</div>
    <div v-else-if="data" ref="el" class="ret-chart"></div>
  </div>
</template>

<script setup lang="ts">
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { RetHistogramResult } from '@/api/modules/strategy/signalStats'
import { useSignalStatsStore } from '@/stores/signalStats'

const props = defineProps<{ runId: string }>()

const store = useSignalStatsStore()
const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

const loading = ref(false)
const error = ref<string | null>(null)
const data = ref<RetHistogramResult | null>(null)

async function fetchAndRender() {
  loading.value = true
  error.value = null
  data.value = null
  try {
    const result = await store.fetchRetHistogram(props.runId)
    data.value = result
    // loading 必须在 initOrRender 之前置 false：图表容器 .ret-chart 受模板 v-if="loading"
    // 互斥门控，loading 仍为 true 时它不在 DOM、el.value 为 undefined → echarts.init 被
    // initOrRender 的 `if (!el.value) return` 跳过，loading 转 false 后又无人重触发 → 图表永远空白。
    loading.value = false
    await nextTick()
    if (result.bins.length === 0) return
    initOrRender()
  } catch (e: unknown) {
    error.value = e instanceof Error ? e.message : '加载直方图失败'
    loading.value = false
  }
}

function initOrRender() {
  if (!el.value) return
  if (!chart) {
    chart = echarts.init(el.value)
  }
  render()
}

function render() {
  if (!chart || !data.value) return
  const bins = data.value.bins
  const sampleCount = data.value.sampleCount

  const labels = bins.map((b) => {
    const lo = (b.lo * 100).toFixed(1)
    const hi = (b.hi * 100).toFixed(1)
    return `${lo}~${hi}`
  })

  chart.setOption({
    grid: { left: 48, right: 24, top: 24, bottom: 56, containLabel: false },
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'shadow' },
      formatter(params: { dataIndex: number }[]) {
        const idx = params[0].dataIndex
        const b = bins[idx]
        const lo = (b.lo * 100).toFixed(1)
        const hi = (b.hi * 100).toFixed(1)
        const pct = sampleCount > 0 ? ((b.count / sampleCount) * 100).toFixed(1) : '0.0'
        return `收益率区间 [${lo}%, ${hi}%)<br/>频数：${b.count} 笔<br/>占比：${pct}%`
      },
    },
    xAxis: {
      type: 'category',
      data: labels,
      name: '%',
      nameLocation: 'end',
      nameTextStyle: { color: '#a0a4ab', fontSize: 11 },
      axisLabel: {
        color: '#a0a4ab',
        fontSize: 10,
        rotate: 45,
        interval: 0,
      },
      axisTick: { show: false },
      axisLine: { lineStyle: { color: 'rgba(160,164,171,0.3)' } },
    },
    yAxis: {
      type: 'value',
      name: '频数',
      nameTextStyle: { color: '#a0a4ab', fontSize: 11 },
      axisLabel: { color: '#a0a4ab', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(160,164,171,0.1)' } },
    },
    series: [
      {
        type: 'bar',
        data: bins.map((b) => b.count),
        barMaxWidth: 24,
        itemStyle: {
          color(p: { dataIndex: number }) {
            return bins[p.dataIndex].sign === 'win' ? '#18a058' : '#d03050'
          },
        },
      },
    ],
  })
}

function resize() {
  chart?.resize()
}

onMounted(async () => {
  await fetchAndRender()
  window.addEventListener('resize', resize)
})

onUnmounted(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
  chart = null
})

watch(
  () => data.value,
  async (val) => {
    if (!val || val.bins.length === 0) return
    await nextTick()
    if (!chart && el.value) {
      chart = echarts.init(el.value)
    }
    chart?.resize()
    render()
  },
)

watch(
  () => props.runId,
  () => {
    if (chart) {
      chart.dispose()
      chart = null
    }
    fetchAndRender()
  },
  { immediate: false },
)
</script>

<style scoped>
.ret-histogram-wrap {
  width: 100%;
  min-height: 240px;
}
.ret-chart {
  width: 100%;
  height: 280px;
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
</style>
