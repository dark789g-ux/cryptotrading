<template>
  <div class="chart-area">
    <div v-if="symbol" class="chart-header">
      <span class="chart-symbol">{{ symbol }}</span>
      <span v-if="lastRow" class="chart-params">
        (stop_loss: {{ fmt(lastRow.stop_loss_pct) }}%  rr: {{ fmt(lastRow.risk_reward_ratio) }})
      </span>
    </div>
    <div v-if="loading" class="placeholder">加载 K 线数据…</div>
    <div v-else-if="error" class="placeholder error-text">{{ error }}</div>
    <div v-else-if="!symbol" class="placeholder">点击左侧标的加载 K 线图</div>
    <div v-show="klines.length" ref="chartEl" class="chart-wrap"></div>
  </div>
</template>

<script setup>
import { ref, watch, onMounted, onUnmounted, nextTick } from 'vue'
import * as echarts from 'echarts'
import { api } from '../../composables/useApi.js'

const props = defineProps({
  symbol: String,
  interval: String,
})

const chartEl = ref(null)
const klines = ref([])
const loading = ref(false)
const error = ref('')
const lastRow = ref(null)
let chart = null

function fmt(v) {
  return v != null && !isNaN(v) ? (+v).toFixed(2) : '-'
}

function parseCsv(csv) {
  const lines = csv.split('\n')
  if (lines.length < 2) return []
  const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(h => h.trim())
  const ci = name => headers.indexOf(name)
  const iT=ci('open_time'),iO=ci('open'),iH=ci('high'),iL=ci('low'),iC=ci('close')
  const iMA5=ci('MA5'),iMA30=ci('MA30'),iMA60=ci('MA60'),iMA120=ci('MA120'),iMA240=ci('MA240')
  const iDIF=ci('DIF'),iDEA=ci('DEA'),iMACD=ci('MACD')
  const iK=ci('KDJ.K'),iD=ci('KDJ.D'),iJ=ci('KDJ.J')
  const iSL=ci('stop_loss_pct'),iRR=ci('risk_reward_ratio')
  return lines.slice(1).filter(l=>l.trim()).map(line => {
    const c = line.split(',')
    const p = (i) => i >= 0 ? parseFloat(c[i]) : null
    return { t:c[iT], o:p(iO), h:p(iH), l:p(iL), c:p(iC),
      ma5:p(iMA5), ma30:p(iMA30), ma60:p(iMA60), ma120:p(iMA120), ma240:p(iMA240),
      dif:p(iDIF), dea:p(iDEA), macd:p(iMACD), k:p(iK), d:p(iD), j:p(iJ),
      stop_loss_pct:p(iSL), risk_reward_ratio:p(iRR) }
  })
}

async function load() {
  if (!props.symbol || !props.interval) return
  loading.value = true; error.value = ''; klines.value = []
  try {
    const csv = await api.getKlines(props.interval, props.symbol)
    const rows = parseCsv(csv)
    klines.value = rows
    lastRow.value = rows.length ? rows[rows.length - 1] : null
    await nextTick()
    renderChart(rows)
  } catch (e) {
    error.value = '加载失败：' + e.message
  } finally {
    loading.value = false
  }
}

function renderChart(rows) {
  if (!chartEl.value) return
  if (!chart) chart = echarts.init(chartEl.value)
  const times = rows.map(r => r.t)
  const ohlc  = rows.map(r => [r.o, r.c, r.l, r.h])
  const ma5   = rows.map(r => r.ma5)
  const ma30  = rows.map(r => r.ma30)
  const ma60  = rows.map(r => r.ma60)
  const ma120 = rows.map(r => r.ma120)
  const ma240 = rows.map(r => r.ma240)
  const dif   = rows.map(r => r.dif)
  const dea   = rows.map(r => r.dea)
  const macdRaw = rows.map(r => r.macd)
  const macd  = macdRaw.map((v,i)=>{
    if(v==null) return null
    const prev = i>0?macdRaw[i-1]:v
    const base = v>=0?'#e74c3c':'#27ae60'
    return {value:v,itemStyle:{color:prev!=null&&v>prev?'transparent':base,borderColor:base,borderWidth:1.5}}
  })
  const kLine = rows.map(r=>r.k), dLine=rows.map(r=>r.d), jLine=rows.map(r=>r.j)
  const sl    = rows.map(r=>r.stop_loss_pct), rr=rows.map(r=>r.risk_reward_ratio)
  const prevClose = rows.map((r,i)=>i>0?rows[i-1].c:null)
  const sp    = times.length>200?((times.length-200)/times.length*100):0
  const fv    = (v,d=4)=>v!=null&&!isNaN(+v)?(+v).toFixed(d):'-'
  const fmtTime = t=>{ if(!t)return ''; return(['1d','3d','1w','1M'].includes(props.interval))?t.slice(0,10):t.slice(0,16) }
  const trend = (c,p)=>c==null||p==null||isNaN(+c)||isNaN(+p)?'':(+c>+p+1e-10?' ↑':+c<+p-1e-10?' ↓':' →')
  const cl = i=>Math.max(0,Math.min(i,times.length-1))
  const RICH_MA  ={ma5v:{fill:'#3498db',fontSize:11},ma30v:{fill:'#e74c3c',fontSize:11},ma60v:{fill:'#27ae60',fontSize:11},ma120v:{fill:'#e67e22',fontSize:11},ma240v:{fill:'#9b59b6',fontSize:11}}
  const RICH_M   ={difv:{fill:'#3498db',fontSize:11},deav:{fill:'#e74c3c',fontSize:11},macdv:{fill:'#888',fontSize:11}}
  const RICH_K   ={kv:{fill:'#3498db',fontSize:11},dv:{fill:'#f39c12',fontSize:11},jv:{fill:'#9b59b6',fontSize:11}}
  const RICH_SR  ={slv:{fill:'#e74c3c',fontSize:11},rrv:{fill:'#27ae60',fontSize:11}}
  const maText=(i)=>{const j=Math.max(0,i-1);return `{ma5v|MA5:${fv(ma5[cl(i)])}${trend(ma5[cl(i)],ma5[cl(j)])}}`+`  {ma30v|MA30:${fv(ma30[cl(i)])}${trend(ma30[cl(i)],ma30[cl(j)])}}  {ma60v|MA60:${fv(ma60[cl(i)])}${trend(ma60[cl(i)],ma60[cl(j)])}}  {ma120v|MA120:${fv(ma120[cl(i)])}${trend(ma120[cl(i)],ma120[cl(j)])}}  {ma240v|MA240:${fv(ma240[cl(i)])}${trend(ma240[cl(i)],ma240[cl(j)])}}`}
  const mText=(i)=>{const j=Math.max(0,i-1);return `{difv|DIF:${fv(dif[cl(i)],6)}${trend(dif[cl(i)],dif[cl(j)])}}  {deav|DEA:${fv(dea[cl(i)],6)}${trend(dea[cl(i)],dea[cl(j)])}}  {macdv|MACD:${fv(macdRaw[cl(i)],6)}${trend(macdRaw[cl(i)],macdRaw[cl(j)])}}`}
  const kText=(i)=>{const j=Math.max(0,i-1);return `{kv|K:${fv(kLine[cl(i)],2)}${trend(kLine[cl(i)],kLine[cl(j)])}}  {dv|D:${fv(dLine[cl(i)],2)}${trend(dLine[cl(i)],dLine[cl(j)])}}  {jv|J:${fv(jLine[cl(i)],2)}${trend(jLine[cl(i)],jLine[cl(j)])}}`}
  const sText=(i)=>{const j=Math.max(0,i-1);return `{slv|stop_loss_pct:${fv(sl[cl(i)],2)}%${trend(sl[cl(i)],sl[cl(j)])}}  {rrv|risk_reward_ratio:${fv(rr[cl(i)],2)}${trend(rr[cl(i)],rr[cl(j)])}}`}

  const option = {
    backgroundColor:'#fff', animation:false,
    tooltip:{trigger:'axis',axisPointer:{type:'cross',lineStyle:{color:'#aaa',type:'dashed'}},
      formatter(params){
        if(!params.length)return '';
        const p0=params.find(p=>p.seriesName==='K线');
        if(!p0||!Array.isArray(p0.value))return '';
        const idx=p0.dataIndex;
        const[o,c,l,hv]=p0.value.map(Number);
        const d=Math.abs(c)>=1000?2:Math.abs(c)>=1?4:6;
        const f=v=>(+v).toFixed(d);
        const prevC=prevClose[idx];
        const chg=prevC!=null?c-prevC:null;
        const chgPct=prevC!=null&&prevC!==0?(c-prevC)/prevC*100:null;
        const chgCol=chg==null?'#888':chg>=0?'#e74c3c':'#27ae60';
        const sgn=v=>v>=0?'+':'';
        let h=`<div style="padding:2px 4px;font-size:12px;line-height:1.9">`;
        h+=`<div>${fmtTime(times[idx])}</div>`;
        h+=`<div>开: ${f(o)}</div>`;
        h+=`<div>高: ${f(hv)}</div>`;
        h+=`<div>低: ${f(l)}</div>`;
        h+=`<div>收: ${f(c)}</div>`;
        if(chg!=null){
          h+=`<div style="color:${chgCol}">涨跌: ${sgn(chg)}${f(chg)}</div>`;
          h+=`<div style="color:${chgCol}">涨幅: ${sgn(chgPct)}${chgPct.toFixed(2)}%</div>`;
        }
        h+=`</div>`;
        return h;
      }},
    axisPointer:{link:[{xAxisIndex:'all'}]},
    legend:{top:2,right:16,itemWidth:14,itemHeight:10,textStyle:{fontSize:11},data:['K线','MA5','MA30','MA60','MA120','MA240','DIF','DEA','MACD','K','D','J','stop_loss_pct','risk_reward_ratio']},
    grid:[{left:68,right:20,top:30,bottom:'48%'},{left:68,right:20,top:'52%',bottom:'36%'},{left:68,right:20,top:'64%',bottom:'20%'},{left:68,right:20,top:'82%',bottom:'6%'}],
    xAxis:[0,1,2,3].map(gi=>({type:'category',data:times,gridIndex:gi,scale:true,axisLabel:{show:gi===3,fontSize:10,rotate:gi===3?20:0,color:'#888'},axisLine:{lineStyle:{color:'#ddd'}}})),
    yAxis:[
      {scale:true,gridIndex:0,splitNumber:5,axisLabel:{fontSize:10,color:'#888'},splitLine:{lineStyle:{color:'#f0f0f0'}}},
      {scale:true,gridIndex:1,splitNumber:3,axisLabel:{fontSize:10,color:'#888'},splitLine:{lineStyle:{color:'#f0f0f0'}}},
      {scale:false,gridIndex:2,splitNumber:4,min:-30,max:130,axisLabel:{fontSize:10,color:'#888'},splitLine:{lineStyle:{color:'#f0f0f0'}}},
      {scale:true,gridIndex:3,splitNumber:3,position:'left',axisLabel:{fontSize:10,color:'#e74c3c',formatter:v=>v!=null?`${(+v).toFixed(2)}%`:''},splitLine:{lineStyle:{color:'rgba(231,76,60,0.2)'}}},
      {scale:true,gridIndex:3,splitNumber:3,position:'right',axisLabel:{fontSize:10,color:'#27ae60',formatter:v=>v!=null?(+v).toFixed(2):''},splitLine:{show:false}},
    ],
    dataZoom:[{type:'inside',xAxisIndex:[0,1,2,3],start:sp,end:100},{type:'slider',xAxisIndex:[0,1,2,3],bottom:'1%',height:20,start:sp,end:100,borderColor:'#ddd',fillerColor:'rgba(52,152,219,.12)',handleStyle:{color:'#3498db'},textStyle:{fontSize:10}}],
    series:[
      {name:'K线',type:'candlestick',xAxisIndex:0,yAxisIndex:0,data:ohlc,itemStyle:{color:'#e74c3c',color0:'#27ae60',borderColor:'#e74c3c',borderColor0:'#27ae60',borderWidth:1}},
      {name:'MA5',type:'line',xAxisIndex:0,yAxisIndex:0,data:ma5,smooth:false,symbol:'none',lineStyle:{color:'#3498db',width:1},itemStyle:{color:'#3498db'}},
      {name:'MA30',type:'line',xAxisIndex:0,yAxisIndex:0,data:ma30,smooth:false,symbol:'none',lineStyle:{color:'#e74c3c',width:1},itemStyle:{color:'#e74c3c'}},
      {name:'MA60',type:'line',xAxisIndex:0,yAxisIndex:0,data:ma60,smooth:false,symbol:'none',lineStyle:{color:'#27ae60',width:1},itemStyle:{color:'#27ae60'}},
      {name:'MA120',type:'line',xAxisIndex:0,yAxisIndex:0,data:ma120,smooth:false,symbol:'none',lineStyle:{color:'#e67e22',width:1},itemStyle:{color:'#e67e22'}},
      {name:'MA240',type:'line',xAxisIndex:0,yAxisIndex:0,data:ma240,smooth:false,symbol:'none',lineStyle:{color:'#9b59b6',width:1},itemStyle:{color:'#9b59b6'}},
      {name:'MACD',type:'bar',xAxisIndex:1,yAxisIndex:1,data:macd,markLine:{silent:true,symbol:'none',lineStyle:{color:'#ccc',type:'dashed'},data:[{yAxis:0}],label:{show:false}}},
      {name:'DIF',type:'line',xAxisIndex:1,yAxisIndex:1,data:dif,smooth:false,symbol:'none',lineStyle:{color:'#3498db',width:1},itemStyle:{color:'#3498db'}},
      {name:'DEA',type:'line',xAxisIndex:1,yAxisIndex:1,data:dea,smooth:false,symbol:'none',lineStyle:{color:'#e74c3c',width:1},itemStyle:{color:'#e74c3c'}},
      {name:'K',type:'line',xAxisIndex:2,yAxisIndex:2,data:kLine,smooth:false,symbol:'none',lineStyle:{color:'#3498db',width:1},itemStyle:{color:'#3498db'},markLine:{silent:true,symbol:'none',data:[{yAxis:10,lineStyle:{color:'#e74c3c',type:'dashed'},label:{show:true,position:'insideEndBottom',fontSize:10,color:'#e74c3c',formatter:'10'}},{yAxis:80,lineStyle:{color:'#ddd',type:'dashed'},label:{show:true,position:'insideEndBottom',fontSize:10,color:'#bbb',formatter:'80'}}]}},
      {name:'D',type:'line',xAxisIndex:2,yAxisIndex:2,data:dLine,smooth:false,symbol:'none',lineStyle:{color:'#f39c12',width:1},itemStyle:{color:'#f39c12'}},
      {name:'J',type:'line',xAxisIndex:2,yAxisIndex:2,data:jLine,smooth:false,symbol:'none',lineStyle:{color:'#9b59b6',width:1},itemStyle:{color:'#9b59b6'}},
      {name:'stop_loss_pct',type:'line',xAxisIndex:3,yAxisIndex:3,data:sl,smooth:false,symbol:'none',lineStyle:{color:'#e74c3c',width:1},itemStyle:{color:'#e74c3c'}},
      {name:'risk_reward_ratio',type:'line',xAxisIndex:3,yAxisIndex:4,data:rr,smooth:false,symbol:'none',lineStyle:{color:'#27ae60',width:1},itemStyle:{color:'#27ae60'}},
    ],
  }
  chart.setOption(option)
  chart.setOption({graphic:[
    {type:'text',id:'ma-info',left:74,top:34,z:100,style:{fill:'#555',fontSize:11,rich:RICH_MA,text:maText(0)}},
    {type:'text',id:'macd-info',left:74,top:'52.5%',z:100,style:{fill:'#555',fontSize:11,rich:RICH_M,text:mText(0)}},
    {type:'text',id:'kdj-info',left:74,top:'64.5%',z:100,style:{fill:'#555',fontSize:11,rich:RICH_K,text:kText(0)}},
    {type:'text',id:'sr-info',left:74,top:'82.5%',z:100,style:{fill:'#555',fontSize:11,rich:RICH_SR,text:sText(0)}},
  ]})
  chart.on('updateAxisPointer',e=>{
    if(!e.axesInfo?.length)return
    const i=e.axesInfo[0].value
    if(i==null||i<0||i>=times.length)return
    chart.setOption({graphic:[
      {id:'ma-info',style:{text:maText(i),rich:RICH_MA}},
      {id:'macd-info',style:{text:mText(i),rich:RICH_M}},
      {id:'kdj-info',style:{text:kText(i),rich:RICH_K}},
      {id:'sr-info',style:{text:sText(i),rich:RICH_SR}},
    ]})
  })
  chart.resize()
}

watch(() => [props.symbol, props.interval], load)
onMounted(() => { if (props.symbol) load() })

const ro = new ResizeObserver(() => chart?.resize())
onMounted(() => chartEl.value && ro.observe(chartEl.value))
onUnmounted(() => { ro.disconnect(); chart?.dispose() })
</script>

<style scoped>
.chart-area {
  flex: 1; min-height: 0; display: flex; flex-direction: column;
  padding: 10px 12px; background: #fff;
}
.chart-header {
  padding: 6px 0 8px; border-bottom: 1px solid var(--color-border);
  margin-bottom: 8px; font-size: 1rem; font-weight: 600;
}
.chart-params { color: var(--color-text-secondary); font-weight: 400; font-size: .9rem; margin-left: 8px; }
.placeholder {
  flex: 1; display: flex; align-items: center; justify-content: center;
  color: var(--color-text-secondary); background: #fafbfc;
  border: 1px dashed var(--color-border); border-radius: 8px;
  font-size: .95rem;
}
.error-text { color: var(--color-danger); }
.chart-wrap { flex: 1; min-height: 0; }
</style>
