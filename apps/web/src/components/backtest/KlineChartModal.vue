<template>
  <n-modal
    :show="show"
    :title="modalTitle"
    preset="card"
    style="width: 1150px; max-width: 95vw"
    :bordered="false"
    :segmented="{ content: true }"
    @update:show="emit('update:show', $event)"
  >
    <n-empty
      v-if="!symbol?.trim()"
      description="未选择标的"
      style="padding: 40px 0"
    />
    <template v-else>
      <div v-if="loading" class="chart-center">
        <n-spin />
      </div>
      <n-empty
        v-else-if="!klineData.length"
        description="暂无该标的K线数据"
        style="padding: 40px 0"
      />
      <div v-else ref="chartRef" class="kline-chart" />
    </template>
  </n-modal>
</template>

<script setup lang="ts">
import { ref, watch, onUnmounted, computed, nextTick } from 'vue'
import * as echarts from 'echarts'
import { useMessage, NModal, NSpin, NEmpty } from 'naive-ui'
import { backtestApi, type KlineChartBar, type TradeOnBar } from '../../composables/useApi'
import { useTheme } from '../../composables/useTheme'
import { MA_COLORS, KDJ_COLORS, CANDLE_COLORS, TRADE_COLORS, TOOLTIP_STYLE, ANCHOR_LINE_COLOR } from '../../composables/chartColors'

const props = defineProps<{
  show: boolean
  runId: string | null
  ts: string
  symbol: string | null
}>()

const emit = defineEmits<{ (e: 'update:show', v: boolean): void }>()

const message = useMessage()
const { echartsTheme } = useTheme()

const loading = ref(false)
const klineData = ref<KlineChartBar[]>([])
const chartRef = ref<HTMLElement | null>(null)
let chartInstance: echarts.ECharts | null = null

const modalTitle = computed(() => {
  const s = props.symbol?.trim() ?? ''
  const t = props.ts ?? ''
  return s ? `K线 · ${s} · ${t}` : `K线 · ${t}`
})

/** 上升红、下降绿；名称避免与 ECharts rich 内置片段冲突 */
const ARROW_RICH = {
  arrowUp: { color: CANDLE_COLORS.up, fontSize: 12 },
  arrowDown: { color: CANDLE_COLORS.down, fontSize: 12 },
  arrowEq: { color: CANDLE_COLORS.eq, fontSize: 12 },
}

const GRAPHIC_MA = { id: 'ma-values', type: 'text' as const, left: '9%', top: '10%', z: 100 }
const GRAPHIC_KDJ = { id: 'kdj-values', type: 'text' as const, left: '9%', top: '71%', z: 100 }

const arrowRichTag = (key: 'up' | 'down' | 'eq'): string => {
  if (key === 'up') return 'arrowUp'
  if (key === 'down') return 'arrowDown'
  return 'arrowEq'
}

const ENTRY_COLOR = TRADE_COLORS.entry
const EXIT_COLOR = TRADE_COLORS.exit
const ENTRY_COLOR_DIM = TRADE_COLORS.entryDim
const EXIT_COLOR_DIM = TRADE_COLORS.exitDim

/** 相对 low 下移比例，标记整体离 K 线更远 */
const MARK_BASE_GAP = 0.008
/** 同一根内按 trades 顺序像素堆叠，避免重叠（与 buildTradesHtml 顺序一致） */
const MARK_STACK_PX = 14

const fmt = (v: unknown, d = 4) =>
  v === null || v === undefined || Number.isNaN(Number(v)) ? '-' : Number(v).toFixed(d)

const arrow = (cur: unknown, prev: unknown): { sym: string; key: 'up' | 'down' | 'eq' } => {
  const c = Number(cur)
  const p = Number(prev)
  if (!Number.isFinite(c) || !Number.isFinite(p)) return { sym: '-', key: 'eq' }
  if (c > p) return { sym: '▲', key: 'up' }
  if (c < p) return { sym: '▼', key: 'down' }
  return { sym: '-', key: 'eq' }
}

const buildMaText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  const prev = idx > 0 && idx - 1 < data.length ? data[idx - 1] : undefined
  const keys = ['MA5', 'MA30', 'MA60', 'MA120', 'MA240'] as const
  const rich: Record<string, unknown> = { ...ARROW_RICH }
  keys.forEach((k) => {
    rich[k.toLowerCase()] = { color: MA_COLORS[k], fontSize: 12 }
  })
  if (!row) {
    return { text: '', rich }
  }
  const segs = keys.map((k) => {
    const a = arrow(row[k], prev?.[k])
    const at = arrowRichTag(a.key)
    return `${k}: {${k.toLowerCase()}|${fmt(row[k])}}{${at}|${a.sym}}`
  })
  return { text: segs.join('  '), rich }
}

const buildKdjText = (idx: number, data: KlineChartBar[]) => {
  const row = idx >= 0 && idx < data.length ? data[idx] : undefined
  const prev = idx > 0 && idx - 1 < data.length ? data[idx - 1] : undefined
  const keys = ['KDJ.K', 'KDJ.D', 'KDJ.J'] as const
  const labels: Record<string, string> = { 'KDJ.K': 'K', 'KDJ.D': 'D', 'KDJ.J': 'J' }
  const tagMap: Record<string, string> = { 'KDJ.K': 'k', 'KDJ.D': 'd', 'KDJ.J': 'j' }
  const rich: Record<string, unknown> = { ...ARROW_RICH }
  keys.forEach((k) => {
    rich[tagMap[k]] = { color: KDJ_COLORS[k], fontSize: 12 }
  })
  if (!row) {
    return { text: '', rich }
  }
  const segs = keys.map((k) => {
    const a = arrow(row[k], prev?.[k])
    const at = arrowRichTag(a.key)
    return `${labels[k]}: {${tagMap[k]}|${fmt(row[k], 2)}}{${at}|${a.sym}}`
  })
  return { text: segs.join('  '), rich }
}

const buildMarkPoints = (data: KlineChartBar[], currentTs: string) => {
  const out: object[] = []

  for (const bar of data) {
    const trades = bar.trades
    if (!trades?.length) continue
    const isCurrentBar = bar.open_time === currentTs
    const low = Number(bar.low)
    if (!Number.isFinite(low) || low <= 0) continue
    const y0 = low * (1 - MARK_BASE_GAP)

    trades.forEach((t, stackIndex) => {
      const isEntry = t.type === 'entry'
      const color = isEntry
        ? isCurrentBar
          ? ENTRY_COLOR
          : ENTRY_COLOR_DIM
        : isCurrentBar
          ? EXIT_COLOR
          : EXIT_COLOR_DIM
      out.push({
        coord: [bar.open_time, y0],
        symbol: 'circle',
        symbolOffset: [0, stackIndex * MARK_STACK_PX],
        symbolSize: isCurrentBar ? 22 : 13,
        itemStyle: { color },
        label: {
          show: true,
          formatter: isEntry ? 'B' : 'S',
          color: '#fff',
          fontSize: isCurrentBar ? 13 : 8,
          fontWeight: isCurrentBar ? 'bold' : 'normal',
        },
      })
    })
  }

  return out
}

const escapeHtml = (s: string) =>
  s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')

/** 后端入场理由等多行为 \\n 分隔；每行一条「字段名 + 值」展示为一行 div */
const reasonLinesToHtml = (reason: string, lineStyle: string) =>
  reason
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => `<div style="${lineStyle}">${escapeHtml(line)}</div>`)
    .join('')

const buildTradesHtml = (trades: TradeOnBar[]): string => {
  if (!trades.length) return ''
  const detailStyle = 'padding-left:12px;margin-top:2px'
  const reasonLineStyle = `${detailStyle};color:${TOOLTIP_STYLE.dimText}`
  const fmtPnl = (n: number) => (n > 0 ? `+${n.toFixed(2)}` : n.toFixed(2))
  const lines = trades.map((t) => {
    if (t.type === 'entry') {
      return `<div style="color:${ENTRY_COLOR};margin-top:4px">
        <div>▶ 入场</div>
        ${reasonLinesToHtml(t.reason, reasonLineStyle)}
        <div style="${detailStyle}">价格: ${fmt(t.price, 4)}</div>
        <div style="${detailStyle}">数量: ${t.shares}</div>
      </div>`
    }
    const rawPnl = Number(t.pnl)
    const pnlNum = Number.isFinite(rawPnl) ? rawPnl : 0
    const pColor = pnlNum > 0 ? ENTRY_COLOR : pnlNum < 0 ? EXIT_COLOR : CANDLE_COLORS.eq
    const exitReasonBlock = t.isHalf ? `${t.reason}\n分批` : t.reason
    return `<div style="color:${EXIT_COLOR};margin-top:4px">
      <div>▶ 出场</div>
      ${reasonLinesToHtml(exitReasonBlock, reasonLineStyle)}
      <div style="${detailStyle}">价格: ${fmt(t.price, 4)}</div>
      <div style="${detailStyle}">盈亏: <span style="color:${pColor}">${fmtPnl(pnlNum)}</span></div>
    </div>`
  })
  return `<div style="margin-top:6px;padding-top:6px;border-top:1px solid ${TOOLTIP_STYLE.divider}">${lines.join('')}</div>`
}

const handleResize = () => chartInstance?.resize()

const renderChart = () => {
  const el = chartRef.value
  const data = klineData.value
  const currentTs = props.ts ?? ''
  if (!el || !data.length) return
  if (chartInstance) chartInstance.dispose()
  chartInstance = echarts.init(el)

  const upColor = CANDLE_COLORS.up
  const downColor = CANDLE_COLORS.down
  const times = data.map((d) => d.open_time)
  const klines = data.map((d) => [d.open, d.close, d.low, d.high])
  const lastIdx = data.length - 1

  chartInstance.setOption({
    ...echartsTheme.value,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross' },
      confine: true,
      formatter: (params: unknown) => {
        const arr = Array.isArray(params) ? params : []
        const p = arr.find((x: { seriesType?: string }) => x.seriesType === 'candlestick')
        if (!p) return ''
        const idx = (p as { dataIndex: number }).dataIndex
        const row = data[idx]
        if (!row) return ''
        const o = Number(row.open)
        const h = Number(row.high)
        const l = Number(row.low)
        const c = Number(row.close)
        const prev = idx > 0 ? Number(data[idx - 1].close) : c
        const diff = c - prev
        const pct = prev ? (diff / prev) * 100 : 0
        const color = diff >= 0 ? upColor : downColor
        const sign = diff >= 0 ? '+' : ''
        const tradesHtml = row.trades?.length ? buildTradesHtml(row.trades) : ''
        return `<div style="font-size:12px;line-height:1.6;max-width:min(360px,85vw);word-break:break-word;overflow-wrap:break-word;box-sizing:border-box">
          <div style="margin-bottom:4px;color:${TOOLTIP_STYLE.muted}">${row.open_time ?? ''}</div>
          <div>开: ${fmt(o, 4)}</div><div>高: ${fmt(h, 4)}</div>
          <div>低: ${fmt(l, 4)}</div><div>收: ${fmt(c, 4)}</div>
          <div style="color:${color}">涨跌: ${sign}${fmt(diff, 4)} (${sign}${pct.toFixed(2)}%)</div>
          ${tradesHtml}
        </div>`
      },
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: [
      {
        orient: 'vertical',
        right: 12,
        top: '8%',
        data: ['K线', 'MA5', 'MA30', 'MA60', 'MA120', 'MA240'],
        textStyle: { fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
      {
        orient: 'vertical',
        right: 12,
        top: '69%',
        data: ['KDJ.K', 'KDJ.D', 'KDJ.J'],
        textStyle: { fontSize: 11 },
        itemWidth: 14,
        itemHeight: 8,
      },
    ],
    grid: [
      { left: '8%', right: '8%', top: '10%', height: '50%' },
      { left: '8%', right: '8%', top: '71%', height: '19%' },
    ],
    xAxis: [
      { type: 'category', data: times, axisLabel: { show: false }, axisPointer: { label: { show: false } } },
      { type: 'category', data: times, gridIndex: 1, axisLabel: { show: false }, axisPointer: { label: { show: true } } },
    ],
    yAxis: [
      { scale: true, axisPointer: { label: { show: false } } },
      { scale: true, gridIndex: 1, axisPointer: { label: { show: false } } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1], start: 0, end: 100 },
      { type: 'slider', xAxisIndex: [0, 1], start: 0, end: 100, bottom: 32, height: 22 },
    ],
    graphic: [
      { ...GRAPHIC_MA, style: buildMaText(lastIdx, data) },
      { ...GRAPHIC_KDJ, style: buildKdjText(lastIdx, data) },
    ],
    series: [
      {
        name: 'K线',
        type: 'candlestick',
        data: klines,
        itemStyle: { color: upColor, color0: downColor, borderColor: upColor, borderColor0: downColor },
        markPoint: { data: buildMarkPoints(data, currentTs), silent: true },
        markLine: {
          symbol: 'none',
          silent: true,
          data: [{ xAxis: currentTs }],
          lineStyle: { color: ANCHOR_LINE_COLOR, width: 1, type: 'dashed' },
          label: { show: false },
        },
      },
      {
        name: 'MA5',
        type: 'line',
        data: data.map((d) => d.MA5),
        showSymbol: false,
        lineStyle: { width: 1, color: MA_COLORS.MA5 },
        itemStyle: { color: MA_COLORS.MA5 },
      },
      {
        name: 'MA30',
        type: 'line',
        data: data.map((d) => d.MA30),
        showSymbol: false,
        lineStyle: { width: 1, color: MA_COLORS.MA30 },
        itemStyle: { color: MA_COLORS.MA30 },
      },
      {
        name: 'MA60',
        type: 'line',
        data: data.map((d) => d.MA60),
        showSymbol: false,
        lineStyle: { width: 1, color: MA_COLORS.MA60 },
        itemStyle: { color: MA_COLORS.MA60 },
      },
      {
        name: 'MA120',
        type: 'line',
        data: data.map((d) => d.MA120),
        showSymbol: false,
        lineStyle: { width: 1, color: MA_COLORS.MA120 },
        itemStyle: { color: MA_COLORS.MA120 },
      },
      {
        name: 'MA240',
        type: 'line',
        data: data.map((d) => d.MA240),
        showSymbol: false,
        lineStyle: { width: 1, color: MA_COLORS.MA240 },
        itemStyle: { color: MA_COLORS.MA240 },
      },
      {
        name: 'KDJ.K',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.map((d) => d['KDJ.K']),
        showSymbol: false,
        lineStyle: { width: 1, color: KDJ_COLORS['KDJ.K'] },
        itemStyle: { color: KDJ_COLORS['KDJ.K'] },
      },
      {
        name: 'KDJ.D',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.map((d) => d['KDJ.D']),
        showSymbol: false,
        lineStyle: { width: 1, color: KDJ_COLORS['KDJ.D'] },
        itemStyle: { color: KDJ_COLORS['KDJ.D'] },
      },
      {
        name: 'KDJ.J',
        type: 'line',
        xAxisIndex: 1,
        yAxisIndex: 1,
        data: data.map((d) => d['KDJ.J']),
        showSymbol: false,
        lineStyle: { width: 1, color: KDJ_COLORS['KDJ.J'] },
        itemStyle: { color: KDJ_COLORS['KDJ.J'] },
      },
    ],
  })

  chartInstance.on('updateAxisPointer', (ev: unknown) => {
    const event = ev as { axesInfo?: { axisDim: string; value: number }[] }
    const info = event?.axesInfo?.find((a) => a.axisDim === 'x')
    const idx = typeof info?.value === 'number' ? info.value : lastIdx
    const safeIdx = idx >= 0 && idx < data.length ? idx : lastIdx
    chartInstance?.setOption({
      graphic: [
        { ...GRAPHIC_MA, style: buildMaText(safeIdx, data) },
        { ...GRAPHIC_KDJ, style: buildKdjText(safeIdx, data) },
      ],
    })
  })

  window.removeEventListener('resize', handleResize)
  window.addEventListener('resize', handleResize)
}

const loadKline = async () => {
  const rid = props.runId
  const ts = props.ts?.trim() ?? ''
  const sym = props.symbol?.trim() ?? ''
  if (!rid || !ts || !sym) return

  chartInstance?.dispose()
  chartInstance = null
  loading.value = true
  klineData.value = []
  try {
    klineData.value = await backtestApi.getKlineChart(rid, {
      symbol: sym,
      ts,
      before: 100,
      after: 30,
    })
  } catch (err: unknown) {
    message.error(err instanceof Error ? err.message : String(err))
  } finally {
    loading.value = false
  }

  if (klineData.value.length) {
    await nextTick()
    await new Promise<void>((r) => requestAnimationFrame(() => r()))
    renderChart()
  }
}

watch(
  () => [props.show, props.runId, props.ts, props.symbol] as const,
  async ([show, rid, ts, sym]) => {
    if (!show) {
      chartInstance?.dispose()
      chartInstance = null
      klineData.value = []
      return
    }
    if (!rid || !ts?.trim() || !sym?.trim()) return
    await loadKline()
  },
)

onUnmounted(() => {
  chartInstance?.dispose()
  window.removeEventListener('resize', handleResize)
})
</script>

<style scoped>
.kline-chart {
  height: 600px;
  width: 100%;
}
.chart-center {
  display: flex;
  justify-content: center;
  padding: 80px 0;
}
</style>
