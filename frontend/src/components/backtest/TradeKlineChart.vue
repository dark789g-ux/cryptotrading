<template>
  <div class="trade-kline-wrap">
    <div v-if="loading" class="placeholder">加载 K 线数据…</div>
    <div v-else-if="error" class="placeholder err">{{ error }}</div>
    <div v-else ref="chartEl" class="chart-el"></div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import * as echarts from 'echarts'
import { api } from '../../composables/useApi.js'

const props = defineProps({
  symbol: String,
  interval: String,
  trade: Object,       // position record from result.positions
  dateStart: String,
  dateEnd: String,
})

const chartEl = ref(null)
const loading = ref(false)
const error = ref('')
let chart = null

function parseCsv(csv) {
  const lines = csv.split('\n')
  if (lines.length < 2) return []
  const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(h => h.trim())
  const ci = n => headers.indexOf(n)
  const iT=ci('open_time'),iO=ci('open'),iH=ci('high'),iL=ci('low'),iC=ci('close')
  const iSL=ci('stop_loss_pct')
  return lines.slice(1).filter(l=>l.trim()).map(line => {
    const c = line.split(',')
    const p = i => i>=0?parseFloat(c[i]):null
    return { t:c[iT], o:p(iO), h:p(iH), l:p(iL), c:p(iC), sl:p(iSL) }
  })
}

async function load() {
  if (!props.symbol || !props.interval) return
  loading.value = true; error.value = ''
  try {
    const csv = await api.getKlines(props.interval, props.symbol)
    let rows = parseCsv(csv)

    // 过滤到回测区间
    if (props.dateStart) rows = rows.filter(r => r.t >= props.dateStart)
    if (props.dateEnd)   rows = rows.filter(r => r.t <= props.dateEnd + ' 23:59:59')

    await nextTick()
    renderChart(rows)
  } catch(e) {
    error.value = '加载失败：' + e.message
  } finally {
    loading.value = false
  }
}

function renderChart(rows) {
  if (!chartEl.value || !rows.length) return
  if (!chart) chart = echarts.init(chartEl.value)

  const times = rows.map(r => r.t)
  const ohlc  = rows.map(r => [r.o, r.c, r.l, r.h])

  // 动态止损线（stop_loss_pct 转为价格近似值，实际用收盘价×(1-sl/100)）
  const slLine = rows.map(r => r.sl != null && !isNaN(r.sl) && r.c != null
    ? +(r.c * (1 - r.sl / 100)).toFixed(8) : null)

  // 买卖点标注
  const markPoints = []
  const t = props.trade
  if (t) {
    const bi = times.findIndex(ts => ts >= t.entry_time)
    if (bi >= 0) markPoints.push({ coord:[bi, +t.entry_price], name:'买入', value:'买',
      itemStyle:{color:'#e74c3c'}, label:{show:true,color:'#fff',fontSize:10} })
    const si = times.findIndex(ts => ts >= t.close_time)
    if (si >= 0) markPoints.push({ coord:[si, +t.sell_price], name:'卖出', value:'卖',
      itemStyle:{color:'#27ae60'}, label:{show:true,color:'#fff',fontSize:10} })
  }

  chart.setOption({
    backgroundColor:'#fff', animation:false,
    tooltip:{ trigger:'axis', axisPointer:{type:'cross'} },
    legend:{ top:4, right:10, itemWidth:12, itemHeight:10, textStyle:{fontSize:11},
      data:['K线','止损线'] },
    grid:{ left:68, right:20, top:28, bottom:40 },
    xAxis:{ type:'category', data:times, scale:true,
      axisLabel:{fontSize:10,color:'#888',rotate:15} },
    yAxis:{ scale:true, axisLabel:{fontSize:10,color:'#888'} },
    dataZoom:[{type:'inside'},{type:'slider',bottom:0,height:16}],
    series:[
      { name:'K线', type:'candlestick', data:ohlc,
        itemStyle:{color:'#e74c3c',color0:'#27ae60',borderColor:'#e74c3c',borderColor0:'#27ae60'},
        markPoint:{
          symbol:'pin', symbolSize:30, data:markPoints,
          label:{show:true,fontSize:10,color:'#fff',fontWeight:'bold'}
        }
      },
      { name:'止损线', type:'line', data:slLine, symbol:'none', smooth:false,
        lineStyle:{color:'#e74c3c',type:'dashed',width:1.5},
        itemStyle:{color:'#e74c3c'} },
    ],
  })
  chart.resize()
}

watch(() => [props.symbol, props.interval, props.trade], load)
onMounted(load)

const ro = new ResizeObserver(() => chart?.resize())
onMounted(() => chartEl.value && ro.observe(chartEl.value))
onUnmounted(() => { ro.disconnect(); chart?.dispose() })
</script>

<style scoped>
.trade-kline-wrap { position: relative; }
.placeholder {
  height: 200px; display: flex; align-items: center; justify-content: center;
  color: var(--color-text-secondary); background: #fafbfc;
  border: 1px dashed var(--color-border); border-radius: var(--radius);
}
.err { color: var(--color-danger); }
.chart-el { width: 100%; height: 300px; }
</style>
