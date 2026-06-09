<template>
  <div class="pareto-scatter-wrap">
    <div v-if="loading" class="state">加载中…</div>
    <div v-else-if="error" class="state err">{{ error }}</div>
    <div v-else-if="!points.length" class="state muted">暂无散点数据</div>
    <div v-else ref="el" class="pareto-chart"></div>
  </div>
</template>

<script setup lang="ts">
/**
 * 帕累托前沿散点图（ECharts scatter）
 *
 * - x = n_valid（信号数），y = kelly_valid（凯利值）
 * - is_frontier 点高亮 + 连线；below_floor / kelly_valid=null 灰点
 * - 模板参照 RetHistogram.vue：onMounted init / window.resize / onUnmounted dispose
 */
import { nextTick, onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'
import type { KellyScatterPoint } from '@/api/modules/quant/kellySweep'

const props = defineProps<{
  points: KellyScatterPoint[]
  loading?: boolean
  error?: string | null
}>()

const el = ref<HTMLDivElement>()
let chart: echarts.ECharts | null = null

/** 将点分成三类：前沿高亮、普通有效、灰点（无效/below_floor） */
function buildSeriesData(pts: KellyScatterPoint[]) {
  const frontier: [number, number, KellyScatterPoint][] = []
  const normal: [number, number, KellyScatterPoint][] = []
  const gray: [number | null, number | null, KellyScatterPoint][] = []

  for (const p of pts) {
    if (p.below_floor || p.kelly_valid === null) {
      gray.push([p.n_valid, p.kelly_valid, p])
    } else if (p.is_frontier) {
      frontier.push([p.n_valid ?? 0, p.kelly_valid, p])
    } else {
      normal.push([p.n_valid ?? 0, p.kelly_valid, p])
    }
  }

  // 前沿点按 n_valid 升序排列（连线需要）
  frontier.sort((a, b) => a[0] - b[0])
  return { frontier, normal, gray }
}

function buildTooltipContent(p: KellyScatterPoint) {
  const kelly = p.kelly_valid !== null ? p.kelly_valid.toFixed(3) : 'N/A'
  const n = p.n_valid ?? 'N/A'
  const variant = p.variant_id ?? '—'
  const exit = p.exit_id ?? '—'
  const flags: string[] = []
  if (p.is_frontier) flags.push('前沿')
  if (p.below_floor) flags.push('below_floor')
  return [
    `变体: ${variant}`,
    `出场: ${exit}`,
    `信号数(n): ${n}`,
    `凯利(f*): ${kelly}`,
    ...(flags.length ? [`标记: ${flags.join('/')}`] : []),
  ].join('<br/>')
}

function render() {
  if (!chart) return
  const pts = props.points
  if (!pts.length) return

  const { frontier, normal, gray } = buildSeriesData(pts)

  chart.setOption({
    grid: { left: 56, right: 24, top: 32, bottom: 56, containLabel: false },
    tooltip: {
      trigger: 'item',
      formatter(param: { data: [number | null, number | null, KellyScatterPoint] }) {
        return buildTooltipContent(param.data[2])
      },
    },
    xAxis: {
      type: 'value',
      name: '信号数 n',
      nameLocation: 'end',
      nameTextStyle: { color: '#a0a4ab', fontSize: 11 },
      axisLabel: { color: '#a0a4ab', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(160,164,171,0.1)' } },
      axisLine: { lineStyle: { color: 'rgba(160,164,171,0.3)' } },
    },
    yAxis: {
      type: 'value',
      name: 'Kelly f*',
      nameTextStyle: { color: '#a0a4ab', fontSize: 11 },
      axisLabel: { color: '#a0a4ab', fontSize: 11 },
      splitLine: { lineStyle: { color: 'rgba(160,164,171,0.1)' } },
    },
    series: [
      // 普通有效点
      {
        name: '有效',
        type: 'scatter',
        symbolSize: 5,
        data: normal,
        itemStyle: { color: '#63b3ed', opacity: 0.65 },
      },
      // 灰点（无效/below_floor）
      {
        name: '无效',
        type: 'scatter',
        symbolSize: 4,
        data: gray,
        itemStyle: { color: '#5a5f6e', opacity: 0.4 },
      },
      // 前沿点高亮（折线 + 散点）
      {
        name: '帕累托前沿',
        type: 'line',
        symbolSize: 9,
        data: frontier,
        lineStyle: { color: '#f6a623', width: 1.5 },
        itemStyle: { color: '#f6a623', borderWidth: 2, borderColor: '#fff' },
        z: 10,
      },
    ],
  })
}

function initOrRender() {
  if (!el.value) return
  if (!chart) {
    chart = echarts.init(el.value)
  }
  render()
}

function resize() {
  chart?.resize()
}

onMounted(async () => {
  if (props.points.length) {
    await nextTick()
    initOrRender()
  }
  window.addEventListener('resize', resize)
})

onUnmounted(() => {
  window.removeEventListener('resize', resize)
  chart?.dispose()
  chart = null
})

watch(
  () => props.points,
  async (val) => {
    if (!val.length) {
      // M3 修复：points 变空时清空旧图，避免残留上一个 job 的散点
      chart?.clear()
      return
    }
    await nextTick()
    if (!chart && el.value) {
      chart = echarts.init(el.value)
    }
    render()
    chart?.resize()
  },
)
</script>

<style scoped>
.pareto-scatter-wrap {
  width: 100%;
  min-height: 240px;
}
.pareto-chart {
  width: 100%;
  height: 280px;
}
.state {
  padding: 32px;
  text-align: center;
  font-size: 13px;
}
.muted { color: var(--color-text-muted); }
.err { color: var(--color-error, #d03050); }
</style>
