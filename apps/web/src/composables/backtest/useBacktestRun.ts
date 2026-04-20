import { ref, computed, watch, onMounted, onUnmounted, nextTick, type Ref } from 'vue'
import * as echarts from 'echarts'
import { useMessage } from 'naive-ui'
import { backtestApi } from '../useApi'
import { useTheme } from '../useTheme'

type ActiveTab = 'kpiOverview' | 'positions' | 'symbols' | 'config' | 'candleLog'

export function useBacktestRun(
  strategy: Ref<any>,
  propRun: Ref<any>,
  activeTab: Ref<ActiveTab>,
) {
  const message = useMessage()
  const { echartsTheme } = useTheme()
  const chartRef = ref<HTMLElement | null>(null)
  let chart: echarts.ECharts | null = null

  const allRuns = ref<any[]>([])
  const selectedRunId = ref<string | null>(null)
  const currentRunDetail = ref<any>(null)
  const reportData = ref<any>(null)

  const runOptions = computed(() =>
    allRuns.value.map((r) => ({
      label: `${new Date(r.createdAt).toLocaleString('zh-CN')} · ${r.timeframe}`,
      value: r.id,
    })),
  )

  const statItems = computed(() => {
    const s = reportData.value?.stats
    if (!s) return []
    return [
      { label: '总收益率', value: `${s.totalReturnPct?.toFixed(2)}%`, cls: s.totalReturnPct >= 0 ? 'trend-up' : 'trend-down' },
      { label: '最终净值', value: `${s.finalValue?.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} USDT`, cls: '' },
      { label: '最大回撤', value: `${s.maxDrawdownPct?.toFixed(2)}%`, cls: 'trend-down' },
      { label: '夏普率(年化)', value: s.sharpeAnnualized?.toFixed(3) ?? '-', cls: '' },
      { label: '完整交易次数', value: s.fullTradeCount ?? 0, cls: '' },
      { label: '胜率', value: `${s.winRate?.toFixed(1)}%`, cls: '' },
      { label: '胜场平均收益', value: `${s.avgWinReturnPct?.toFixed(2)}%`, cls: 'trend-up' },
      { label: '败场平均亏损', value: `${s.avgLossReturnPct?.toFixed(2)}%`, cls: 'trend-down' },
      { label: '平均持仓周期', value: `${s.avgHoldCandles?.toFixed(1)} 根`, cls: '' },
      { label: '满仓K时长', value: `${s.fullPositionBars ?? 0} 根 (${s.fullPositionPct?.toFixed(1) ?? '0.0'}%)`, cls: '' },
    ]
  })

  const symbolOptions = computed(() => {
    const values = new Set<string>()
    for (const item of currentRunDetail.value?.symbols ?? []) {
      if (typeof item === 'string' && item.trim()) values.add(item.trim())
    }
    for (const row of reportData.value?.positions ?? []) {
      if (typeof row?.symbol === 'string' && row.symbol.trim()) values.add(row.symbol.trim())
    }
    for (const row of reportData.value?.symbols ?? []) {
      if (typeof row?.symbol === 'string' && row.symbol.trim()) values.add(row.symbol.trim())
    }
    return [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ label: value, value }))
  })

  const stopTypeOptions = computed(() => {
    const values = new Set<string>()
    for (const row of reportData.value?.positions ?? []) {
      if (!Array.isArray(row?.stopTypes)) continue
      for (const stopType of row.stopTypes) {
        if (typeof stopType === 'string' && stopType.trim()) values.add(stopType.trim())
      }
    }
    return [...values].sort((a, b) => a.localeCompare(b)).map((value) => ({ label: value, value }))
  })

  const renderChart = () => {
    if (!chartRef.value || !reportData.value?.portfolio) return
    if (chart) chart.dispose()
    chart = echarts.init(chartRef.value)
    const { labels, values } = reportData.value.portfolio
    const capRaw = reportData.value.stats?.initialCapital
    const cap = typeof capRaw === 'number' ? capRaw : Number(capRaw)
    const showInitialLine = Number.isFinite(cap) && cap > 0
    const initialLabel = showInitialLine
      ? `初始资金 ${cap.toLocaleString('zh-CN', { maximumFractionDigits: 0 })} USDT`
      : ''

    const lineSeries: echarts.SeriesOption = {
      name: '净值',
      type: 'line',
      data: values,
      smooth: false,
      showSymbol: false,
      areaStyle: { opacity: 0.2 },
    }
    if (showInitialLine) {
      lineSeries.markLine = {
        silent: true,
        symbol: 'none',
        lineStyle: { type: 'dashed', width: 1, color: '#A8A29E' },
        label: { show: true, formatter: initialLabel },
        data: [{ yAxis: cap }],
      }
    }

    chart.setOption({
      ...echartsTheme.value,
      tooltip: { trigger: 'axis' },
      grid: { left: '8%', right: '4%', bottom: '12%', top: '8%' },
      xAxis: { type: 'category', data: labels, axisLabel: { rotate: 30 } },
      yAxis: { type: 'value', scale: true },
      dataZoom: [{ type: 'inside', start: 0, end: 100 }, { type: 'slider' }],
      series: [lineSeries],
    })
  }

  const loadRun = async (runId: string) => {
    try {
      const full = await backtestApi.getRun(runId)
      currentRunDetail.value = full ?? null
      reportData.value = full?.stats ?? null
      activeTab.value = 'kpiOverview'
    } catch (err: unknown) {
      message.error(err instanceof Error ? err.message : String(err))
    }
  }

  watch([activeTab, reportData], ([tab, data]) => {
    if (tab === 'kpiOverview' && (data as any)?.portfolio) nextTick(() => renderChart())
  })

  watch(propRun, async (r) => {
    if (!r) { currentRunDetail.value = null; reportData.value = null; return }
    try {
      allRuns.value = await backtestApi.listRuns(strategy.value.id)
      if (allRuns.value.length) {
        selectedRunId.value = allRuns.value[0].id
        await loadRun(selectedRunId.value)
      }
    } catch { /* ignore */ }
  }, { immediate: true })

  onMounted(() => { window.addEventListener('resize', () => chart?.resize()) })
  onUnmounted(() => { chart?.dispose(); window.removeEventListener('resize', () => chart?.resize()) })

  return {
    chartRef,
    allRuns,
    selectedRunId,
    currentRunDetail,
    reportData,
    runOptions,
    statItems,
    symbolOptions,
    stopTypeOptions,
    loadRun,
  }
}
