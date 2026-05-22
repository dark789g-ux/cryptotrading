<template>
  <div ref="el" class="oos-trend-chart"></div>
</template>

<script setup lang="ts">
import { onMounted, onUnmounted, ref, watch } from 'vue'
import * as echarts from 'echarts'

/**
 * 最近 N 日 OOS 指标趋势小图
 * - x: 日期；多条线：NDCG@10 / IC / 单笔净收益中位数
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

/**
 * 异常值兜底：这三个指标（NDCG / IC / 单笔净收益中位数）量级都在 ±1 附近，
 * 正常不会超过 ±10。历史脏数据（曾出现 1e123 量级的错误年化值）会把 Y 轴
 * 整个撑爆、压扁其它正常曲线。此处把非有限值或越界值一律置 null（绘成断点），
 * 并 warn 出来便于排查。
 */
const SANE_ABS_LIMIT = 10

function sane(v: number | null | undefined, seriesName: string, date: string): number | null {
  if (v === null || v === undefined) return null
  if (!Number.isFinite(v) || Math.abs(v) > SANE_ABS_LIMIT) {
    console.warn(
      `[OosTrendChart] 丢弃异常值 ${seriesName}@${date}=${v}（超出 ±${SANE_ABS_LIMIT} 或非有限值）`,
    )
    return null
  }
  return v
}

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
        data: props.points.map(p => sane(p.ndcg10, 'NDCG@10', p.date)),
        smooth: true,
        connectNulls: true,
      },
      {
        name: 'IC',
        type: 'line',
        data: props.points.map(p => sane(p.ic, 'IC', p.date)),
        smooth: true,
        connectNulls: true,
      },
      {
        name: '单笔净收益(中位)',
        type: 'line',
        data: props.points.map(
          p => sane(p.portfolio_annual_after_cost, '单笔净收益(中位)', p.date),
        ),
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
