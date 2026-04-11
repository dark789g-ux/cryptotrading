<template>
  <div class="backtest-detail">
    <n-empty v-if="!result && !loading" description="暂无回测结果" />
    
    <n-spin v-else-if="loading" />
    
    <template v-else>
      <!-- 统计指标 -->
      <div class="detail-stats">
        <div class="detail-stat-item">
          <span class="label">总收益率</span>
          <span class="value" :class="result.returns?.total >= 0 ? 'trend-up' : 'trend-down'">
            {{ formatPercent(result.returns?.total) }}
          </span>
        </div>
        <div class="detail-stat-item">
          <span class="label">年化收益率</span>
          <span class="value" :class="result.returns?.annualized >= 0 ? 'trend-up' : 'trend-down'">
            {{ formatPercent(result.returns?.annualized) }}
          </span>
        </div>
        <div class="detail-stat-item">
          <span class="label">最大回撤</span>
          <span class="value trend-down">{{ formatPercent(result.max_drawdown) }}</span>
        </div>
        <div class="detail-stat-item">
          <span class="label">夏普比率</span>
          <span class="value">{{ result.sharpe_ratio?.toFixed(2) || '-' }}</span>
        </div>
        <div class="detail-stat-item">
          <span class="label">交易次数</span>
          <span class="value">{{ result.total_trades || 0 }}</span>
        </div>
        <div class="detail-stat-item">
          <span class="label">胜率</span>
          <span class="value">{{ formatPercent(result.win_rate) }}</span>
        </div>
      </div>

      <n-divider />

      <!-- 收益曲线图 -->
      <div class="chart-section">
        <h4 class="section-title">收益曲线</h4>
        <div ref="chartRef" class="chart-container"></div>
      </div>

      <n-divider />

      <!-- 交易记录 -->
      <div class="trades-section">
        <div class="section-header">
          <h4 class="section-title">交易记录</h4>
          <n-space>
            <n-button size="small" @click="exportTrades">
              <template #icon><n-icon><download-outline /></n-icon></template>
              导出 CSV
            </n-button>
          </n-space>
        </div>
        
        <n-data-table
          :columns="tradeColumns"
          :data="trades"
          :pagination="{ pageSize: 10 }"
          :max-height="400"
          size="small"
        />
      </div>
    </template>
  </div>
</template>

<script setup>
import { ref, computed, onMounted, onUnmounted, watch, nextTick } from 'vue'
import * as echarts from 'echarts'
import { NEmpty, NSpin, NDivider, NDataTable, NSpace, NButton, NIcon } from 'naive-ui'
import { DownloadOutline } from '@vicons/ionicons5'
import { useTheme } from '../../composables/useTheme.js'

const props = defineProps({
  strategy: Object,
  result: Object,
  loading: Boolean
})

const { echartsTheme } = useTheme()

const chartRef = ref(null)
let chart = null

// 交易数据
const trades = computed(() => {
  if (!props.result?.trades) return []
  return props.result.trades.map((t, i) => ({
    key: i,
    ...t,
    pnl: t.exit_price && t.entry_price 
      ? (t.side === 'LONG' ? 1 : -1) * (t.exit_price - t.entry_price) * (t.quantity || 1)
      : null
  }))
})

// 格式化
const formatPercent = (val) => {
  if (val === null || val === undefined) return '-'
  const sign = val >= 0 ? '+' : ''
  return `${sign}${(val * 100).toFixed(2)}%`
}

const formatNumber = (val, digits = 4) => {
  if (val === null || val === undefined) return '-'
  return val.toFixed(digits)
}

const formatDate = (val) => {
  if (!val) return '-'
  return new Date(val).toLocaleString('zh-CN')
}

// 交易表格列
const tradeColumns = [
  { title: '标的', key: 'symbol', width: 100 },
  { title: '方向', key: 'side', width: 80 },
  { 
    title: '开仓时间', 
    key: 'entry_time', 
    width: 150,
    render: (row) => formatDate(row.entry_time)
  },
  { 
    title: '开仓价', 
    key: 'entry_price', 
    width: 100,
    render: (row) => formatNumber(row.entry_price)
  },
  { 
    title: '平仓时间', 
    key: 'exit_time', 
    width: 150,
    render: (row) => formatDate(row.exit_time)
  },
  { 
    title: '平仓价', 
    key: 'exit_price', 
    width: 100,
    render: (row) => formatNumber(row.exit_price)
  },
  { 
    title: '盈亏', 
    key: 'pnl', 
    width: 120,
    render: (row) => {
      const val = row.pnl
      if (val === null) return '-'
      return h('span', {
        class: val >= 0 ? 'trend-up' : 'trend-down'
      }, formatNumber(val, 2))
    }
  },
  { title: '收益率', key: 'return_pct', width: 100, render: (row) => formatPercent(row.return_pct) }
]

// 初始化图表
const initChart = () => {
  if (!chartRef.value || !props.result?.equity_curve) return
  
  if (chart) {
    chart.dispose()
  }
  
  chart = echarts.init(chartRef.value)
  
  const data = props.result.equity_curve
  const xData = data.map(d => new Date(d.time).toLocaleDateString())
  const yData = data.map(d => d.value)
  
  const option = {
    ...echartsTheme.value,
    grid: {
      left: '3%',
      right: '4%',
      bottom: '3%',
      top: '10%',
      containLabel: true
    },
    tooltip: {
      trigger: 'axis',
      formatter: (params) => {
        const p = params[0]
        return `${p.name}<br/>净值: ${p.value.toFixed(2)}`
      }
    },
    xAxis: {
      type: 'category',
      data: xData,
      boundaryGap: false
    },
    yAxis: {
      type: 'value',
      scale: true
    },
    series: [{
      name: '净值',
      type: 'line',
      data: yData,
      smooth: true,
      showSymbol: false,
      lineStyle: {
        width: 2,
        color: '#667eea'
      },
      areaStyle: {
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [
          { offset: 0, color: 'rgba(102, 126, 234, 0.3)' },
          { offset: 1, color: 'rgba(102, 126, 234, 0.01)' }
        ])
      }
    }]
  }
  
  chart.setOption(option)
}

// 导出交易记录
const exportTrades = () => {
  const headers = ['标的', '方向', '开仓时间', '开仓价', '平仓时间', '平仓价', '数量', '盈亏', '收益率']
  const rows = trades.value.map(t => [
    t.symbol,
    t.side,
    t.entry_time,
    t.entry_price,
    t.exit_time,
    t.exit_price,
    t.quantity,
    t.pnl,
    t.return_pct
  ])
  
  const csv = [headers.join(','), ...rows.map(r => r.join(','))].join('\n')
  const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' })
  const link = document.createElement('a')
  link.href = URL.createObjectURL(blob)
  link.download = `trades_${props.strategy?.name}_${new Date().toISOString().slice(0, 10)}.csv`
  link.click()
}

// 监听结果变化
watch(() => props.result, () => {
  if (props.result) {
    nextTick(initChart)
  }
}, { immediate: true })

onMounted(() => {
  window.addEventListener('resize', () => chart?.resize())
})

onUnmounted(() => {
  chart?.dispose()
  window.removeEventListener('resize', () => chart?.resize())
})
</script>

<style scoped>
.backtest-detail {
  height: 100%;
}

.detail-stats {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 16px;
  margin-bottom: 16px;
}

.detail-stat-item {
  background: var(--glass-bg);
  border: 1px solid var(--glass-border);
  border-radius: 12px;
  padding: 16px;
  text-align: center;
}

.detail-stat-item .label {
  display: block;
  font-size: 12px;
  color: var(--text-secondary);
  margin-bottom: 4px;
}

.detail-stat-item .value {
  font-size: 20px;
  font-weight: 600;
  color: var(--text-primary);
}

.chart-section {
  margin: 16px 0;
}

.section-title {
  font-size: 16px;
  font-weight: 600;
  margin: 0 0 12px 0;
  color: var(--text-primary);
}

.chart-container {
  height: 280px;
  border-radius: 12px;
  overflow: hidden;
}

.trades-section {
  margin-top: 16px;
}

.section-header {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 12px;
}
</style>
