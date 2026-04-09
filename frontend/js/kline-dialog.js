/* kline-dialog.js - K线图对话框功能 */

let _klineChart = null;

// CSV 解析
function _parseCsvKlines(csvText) {
  const lines = csvText.split('\n');
  if (lines.length < 2) return [];

  const headers = lines[0].replace(/^\uFEFF/, '').split(',').map(function(h) { return h.trim(); });
  function ci(name) { return headers.indexOf(name); }

  const iT = ci('open_time'), iO = ci('open'), iH = ci('high'), iL = ci('low'), iC = ci('close');
  const iMA5 = ci('MA5'), iMA30 = ci('MA30'), iMA60 = ci('MA60'), iMA120 = ci('MA120'), iMA240 = ci('MA240');
  const iDIF = ci('DIF'), iDEA = ci('DEA'), iMACD = ci('MACD');
  const iK = ci('KDJ.K'), iD = ci('KDJ.D'), iJ = ci('KDJ.J');
  const iStopLossPct = ci('stop_loss_pct'), iRiskReward = ci('risk_reward_ratio');

  const rows = [];
  for (var i = 1; i < lines.length; i++) {
    var line = lines[i].trim();
    if (!line) continue;
    var c = line.split(',');
    rows.push({
      t:       c[iT],
      o:       parseFloat(c[iO]),
      h:       parseFloat(c[iH]),
      l:       parseFloat(c[iL]),
      c:       parseFloat(c[iC]),
      ma5:     iMA5     >= 0 ? parseFloat(c[iMA5])     : null,
      ma30:    iMA30    >= 0 ? parseFloat(c[iMA30])    : null,
      ma60:    iMA60    >= 0 ? parseFloat(c[iMA60])    : null,
      ma120:   iMA120   >= 0 ? parseFloat(c[iMA120])   : null,
      ma240:   iMA240   >= 0 ? parseFloat(c[iMA240])   : null,
      dif:     iDIF     >= 0 ? parseFloat(c[iDIF])     : null,
      dea:     iDEA     >= 0 ? parseFloat(c[iDEA])     : null,
      macd:    iMACD    >= 0 ? parseFloat(c[iMACD])    : null,
      k:       iK       >= 0 ? parseFloat(c[iK])       : null,
      d:       iD       >= 0 ? parseFloat(c[iD])       : null,
      j:       iJ       >= 0 ? parseFloat(c[iJ])       : null,
      stop_loss_pct: iStopLossPct >= 0 ? parseFloat(c[iStopLossPct]) : null,
      risk_reward_ratio: iRiskReward >= 0 ? parseFloat(c[iRiskReward]) : null,
    });
  }
  return rows;
}

// 按交易时间裁剪窗口
function _sliceKlineWindow(allRows, symTxns) {
  if (!allRows.length) return allRows;
  const BEFORE = 100, AFTER = 50;
  const txnTimes = new Set(symTxns.map(function(x) { return x.time; }));
  var first = allRows.length - 1, last = 0;
  allRows.forEach(function(row, i) {
    if (txnTimes.has(row.t)) {
      if (i < first) first = i;
      if (i > last)  last  = i;
    }
  });
  if (first > last) return allRows;
  return allRows.slice(Math.max(0, first - BEFORE), Math.min(allRows.length, last + AFTER + 1));
}

// 构造 markPoint 数据
function _buildBSMarks(klines, symTxns) {
  const timeMap = {};
  klines.forEach(function(k, i) { timeMap[k.t] = i; });

  const byTime = {};
  symTxns.forEach(function(txn) {
    if (!byTime[txn.time]) byTime[txn.time] = [];
    byTime[txn.time].push(txn);
  });

  const marks = [];
  Object.keys(byTime).forEach(function(t) {
    const idx = timeMap[t];
    if (idx === undefined) return;
    const k = klines[idx];
    if (!k || k.l == null) return;

    byTime[t].forEach(function(txn, i) {
      const isBuy = txn.direction === '买入';
      const yOffset = 22 + i * 20;
      marks.push({
        coord: [t, k.l],
        symbolOffset: [0, yOffset],
        symbol: 'roundRect',
        symbolSize: [18, 16],
        label: {
          show: true,
          formatter: isBuy ? 'B' : 'S',
          color: '#fff',
          fontSize: 10,
          fontWeight: 'bold',
        },
        itemStyle: {
          color: isBuy ? '#e74c3c' : '#27ae60',
          borderColor: isBuy ? '#c0392b' : '#1e8449',
          borderWidth: 1,
        },
      });
    });
  });
  return marks;
}

// 渲染 K 线图
function _renderKlineChart(chart, klines, focusTime, symTxns) {
  const times   = klines.map(k => k.t);
  const ohlc    = klines.map(k => [k.o, k.c, k.l, k.h]);
  const ma5     = klines.map(k => k.ma5);
  const ma30    = klines.map(k => k.ma30);
  const ma60    = klines.map(k => k.ma60);
  const ma120   = klines.map(k => k.ma120);
  const ma240   = klines.map(k => k.ma240);
  const stopLossPct = klines.map(k => k.stop_loss_pct);
  const riskRewardRatio = klines.map(k => k.risk_reward_ratio);
  const dif    = klines.map(k => k.dif);
  const dea    = klines.map(k => k.dea);
  const macdRaw = klines.map(k => k.macd);
  const macd = macdRaw.map(function(v, i) {
    if (v === null || v === undefined) return null;
    const prev = i > 0 ? macdRaw[i - 1] : v;
    const isHollow = prev !== null && v > prev;
    const baseColor = v >= 0 ? '#e74c3c' : '#27ae60';
    return {
      value: v,
      itemStyle: {
        color:       isHollow ? 'transparent' : baseColor,
        borderColor: baseColor,
        borderWidth: 1.5,
      },
    };
  });
  const kLine  = klines.map(k => k.k);
  const dLine  = klines.map(k => k.d);
  const jLine  = klines.map(k => k.j);

  const txnByTime = {};
  symTxns.forEach(function(x) {
    if (!txnByTime[x.time]) txnByTime[x.time] = [];
    txnByTime[x.time].push(x);
  });

  const fi = Math.max(0, times.indexOf(focusTime));
  const ws = Math.max(0, fi - 100);
  const we = Math.min(times.length - 1, fi + 100);
  const sp = (ws / times.length) * 100;
  const ep = (we / times.length) * 100;

  function _FONT() { return '"Segoe UI","Microsoft YaHei",sans-serif'; }

  function buildMAText(idx) {
    const i = clampIdx(idx, ma5), j = Math.max(0, i - 1);
    return '{ma5val|MA5: ' + fv(ma5[i], 4) + trend(ma5[i], ma5[j]) + '}   '
         + '{ma30val|MA30: ' + fv(ma30[i], 4) + trend(ma30[i], ma30[j]) + '}   '
         + '{ma60val|MA60: ' + fv(ma60[i], 4) + trend(ma60[i], ma60[j]) + '}   '
         + '{ma120val|MA120: ' + fv(ma120[i], 4) + trend(ma120[i], ma120[j]) + '}   '
         + '{ma240val|MA240: ' + fv(ma240[i], 4) + trend(ma240[i], ma240[j]) + '}';
  }
  function buildMacdText(idx) {
    const i = clampIdx(idx, macdRaw), j = Math.max(0, i - 1);
    return '{difval|DIF: '  + fsig(dif[i],     6) + trend(dif[i],     dif[j])     + '}   '
         + '{deaval|DEA: '  + fsig(dea[i],     6) + trend(dea[i],     dea[j])     + '}   '
         + '{macdval|MACD: '+ fsig(macdRaw[i], 6) + trend(macdRaw[i], macdRaw[j]) + '}';
  }
  function buildKdjText(idx) {
    const i = clampIdx(idx, kLine), j = Math.max(0, i - 1);
    return '{kval|K: ' + fv(kLine[i], 2) + trend(kLine[i], kLine[j]) + '}   '
         + '{dval|D: ' + fv(dLine[i], 2) + trend(dLine[i], dLine[j]) + '}   '
         + '{jval|J: ' + fv(jLine[i], 2) + trend(jLine[i], jLine[j]) + '}';
  }
  function buildStopRiskText(idx) {
    const i = clampIdx(idx, stopLossPct), j = Math.max(0, i - 1);
    return '{slval|stop_loss_pct: ' + fv(stopLossPct[i], 2) + '%' + trend(stopLossPct[i], stopLossPct[j]) + '}   '
         + '{rrval|risk_reward_ratio: ' + fv(riskRewardRatio[i], 2) + trend(riskRewardRatio[i], riskRewardRatio[j]) + '}';
  }

  const RICH_MA = {
    ma5val:  { fill: '#3498db', fontSize: 11 },
    ma30val: { fill: '#e74c3c', fontSize: 11 },
    ma60val: { fill: '#27ae60', fontSize: 11 },
    ma120val: { fill: '#e67e22', fontSize: 11 },
    ma240val: { fill: '#9b59b6', fontSize: 11 },
  };
  const RICH_STOP_RISK = {
    slval: { fill: '#e74c3c', fontSize: 11 },
    rrval: { fill: '#27ae60', fontSize: 11 },
  };
  const RICH_MACD = {
    difval:  { fill: '#3498db', fontSize: 11 },
    deaval:  { fill: '#e74c3c', fontSize: 11 },
    macdval: { fill: '#888',    fontSize: 11 },
  };
  const RICH_KDJ = {
    kval: { fill: '#3498db', fontSize: 11 },
    dval: { fill: '#f39c12', fontSize: 11 },
    jval: { fill: '#9b59b6', fontSize: 11 },
  };

  const option = {
    backgroundColor: '#fff',
    animation: false,
    tooltip: {
      trigger: 'axis',
      axisPointer: { type: 'cross', lineStyle: { color: '#aaa', type: 'dashed' } },
      formatter: function(params) {
        if (!params.length) return '';
        let html = '<div style="font-size:11px;line-height:1.8;white-space:nowrap">'
                 + '<b>' + params[0].axisValue + '</b><br>';
        params.forEach(function(p) {
          if (p.seriesName === 'K线') {
            if (!Array.isArray(p.value)) return;
            const o = +p.value[1], c = +p.value[2], l = +p.value[3], h = +p.value[4];
            const ref = Math.abs(c) || Math.abs(o) || 1;
            const dec = ref >= 1000 ? 2 : ref >= 100 ? 3 : ref >= 10 ? 4 : ref >= 1 ? 5 : ref >= 0.1 ? 6 : ref >= 0.01 ? 7 : 8;
            const pf  = function(v) { return (+v).toFixed(dec); };
            const col = c >= o ? '#e74c3c' : '#27ae60';
            html += '<span style="color:' + col + '">'
                  + '开:&nbsp;' + pf(o) + '&nbsp;&nbsp;'
                  + '高:&nbsp;' + pf(h) + '&nbsp;&nbsp;'
                  + '低:&nbsp;' + pf(l) + '&nbsp;&nbsp;'
                  + '收:&nbsp;' + pf(c)
                  + '</span><br>';
            const di = p.dataIndex;
            if (di > 0 && ohlc[di - 1]) {
              const prevC = +ohlc[di - 1][1];
              if (prevC) {
                const chg    = c - prevC;
                const chgPct = chg / prevC * 100;
                const sign   = chg >= 0 ? '+' : '';
                const cc     = chg >= 0 ? '#e74c3c' : '#27ae60';
                html += '<span style="color:' + cc + '">涨跌额:&nbsp;' + sign + pf(chg)
                      + '&nbsp;&nbsp;涨跌幅:&nbsp;' + sign + chgPct.toFixed(2) + '%</span><br>';
              }
            }
            const curTime = params[0].axisValue;
            const txns = txnByTime[curTime];
            if (txns && txns.length) {
              txns.forEach(function(x) {
                const tc = x.direction === '买入' ? '#27ae60' : '#e74c3c';
                html += '<span style="color:' + tc + ';font-weight:bold">'
                      + x.direction + '&nbsp;&nbsp;'
                      + '价格:&nbsp;' + pf(+x.price) + '&nbsp;&nbsp;'
                      + '数量:&nbsp;' + x.shares + '&nbsp;&nbsp;'
                      + '金额:&nbsp;' + (+x.amount).toFixed(2)
                      + '</span><br>';
                if (x.reason) {
                  html += '<span style="color:#aaa;font-size:10px">'
                        + x.reason.replace(/\n/g, '<br>&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;&nbsp;')
                        + '</span><br>';
                }
              });
            }
          }
        });
        return html + '</div>';
      }
    },
    axisPointer: { link: [{ xAxisIndex: 'all' }] },
    legend: {
      top: 2, right: 16, itemWidth: 14, itemHeight: 10, textStyle: { fontSize: 11 },
      data: ['K线', 'MA5', 'MA30', 'MA60', 'MA120', 'MA240', 'DIF', 'DEA', 'MACD', 'K', 'D', 'J', 'stop_loss_pct', 'risk_reward_ratio']
    },
    grid: [
      { left: 68, right: 20, top: 30,    bottom: '48%' },
      { left: 68, right: 20, top: '52%', bottom: '36%' },
      { left: 68, right: 20, top: '64%', bottom: '20%' },
      { left: 68, right: 20, top: '82%', bottom: '6%'  },
    ],
    xAxis: [
      { type: 'category', data: times, gridIndex: 0, scale: true,
        axisLabel: { show: false }, axisLine: { lineStyle: { color: '#ddd' } } },
      { type: 'category', data: times, gridIndex: 1, scale: true,
        axisLabel: { show: false }, axisLine: { lineStyle: { color: '#ddd' } } },
      { type: 'category', data: times, gridIndex: 2, scale: true,
        axisLabel: { show: false }, axisLine: { lineStyle: { color: '#ddd' } } },
      { type: 'category', data: times, gridIndex: 3, scale: true,
        axisLabel: { fontSize: 10, rotate: 20, color: '#888' },
        axisLine: { lineStyle: { color: '#ddd' } } },
    ],
    yAxis: [
      { scale: true, gridIndex: 0, splitNumber: 5,
        axisLabel: { fontSize: 10, color: '#888' },
        splitLine: { lineStyle: { color: '#f0f0f0' } } },
      { scale: true, gridIndex: 1, splitNumber: 3,
        axisLabel: { fontSize: 10, color: '#888',
          formatter: function(v) { return fsig(v, 4); }
        },
        splitLine: { lineStyle: { color: '#f0f0f0' } } },
      { scale: false, gridIndex: 2, splitNumber: 4, min: -30, max: 130,
        axisLabel: { fontSize: 10, color: '#888' },
        splitLine: { lineStyle: { color: '#f0f0f0' } } },
      { scale: true, gridIndex: 3, splitNumber: 3, position: 'left',
        axisLabel: { fontSize: 10, color: '#e74c3c',
          formatter: function(v) { return v != null ? (+v).toFixed(2) + '%' : ''; }
        },
        splitLine: { lineStyle: { color: 'rgba(231,76,60,0.2)' } } },
      { scale: true, gridIndex: 3, splitNumber: 3, position: 'right',
        axisLabel: { fontSize: 10, color: '#27ae60',
          formatter: function(v) { return v != null ? (+v).toFixed(2) : ''; }
        },
        splitLine: { show: false } },
    ],
    dataZoom: [
      { type: 'inside', xAxisIndex: [0, 1, 2, 3], start: sp, end: ep },
      { type: 'slider',  xAxisIndex: [0, 1, 2, 3], bottom: '1%', height: 20,
        start: sp, end: ep,
        borderColor: '#ddd', fillerColor: 'rgba(52,152,219,.12)',
        handleStyle: { color: '#3498db' },
        textStyle: { fontSize: 10 } },
    ],
    series: [
      { name: 'K线', type: 'candlestick',
        xAxisIndex: 0, yAxisIndex: 0, data: ohlc,
        itemStyle: { color: '#e74c3c', color0: '#27ae60', borderColor: '#e74c3c', borderColor0: '#27ae60', borderWidth: 1 },
        markPoint: { silent: true, animation: false, data: _buildBSMarks(klines, symTxns) },
      },
      { name: 'MA5', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma5, smooth: false, symbol: 'none',
        lineStyle: { color: '#3498db', width: 1 }, itemStyle: { color: '#3498db' } },
      { name: 'MA30', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma30, smooth: false, symbol: 'none',
        lineStyle: { color: '#e74c3c', width: 1 }, itemStyle: { color: '#e74c3c' } },
      { name: 'MA60', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma60, smooth: false, symbol: 'none',
        lineStyle: { color: '#27ae60', width: 1 }, itemStyle: { color: '#27ae60' } },
      { name: 'MA120', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma120, smooth: false, symbol: 'none',
        lineStyle: { color: '#e67e22', width: 1 }, itemStyle: { color: '#e67e22' } },
      { name: 'MA240', type: 'line', xAxisIndex: 0, yAxisIndex: 0, data: ma240, smooth: false, symbol: 'none',
        lineStyle: { color: '#9b59b6', width: 1 }, itemStyle: { color: '#9b59b6' } },
      { name: 'MACD', type: 'bar', xAxisIndex: 1, yAxisIndex: 1, data: macd,
        markLine: { silent: true, symbol: 'none', lineStyle: { color: '#ccc', type: 'dashed', width: 1 },
          data: [{ yAxis: 0 }], label: { show: false } },
      },
      { name: 'DIF', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: dif, smooth: false, symbol: 'none',
        lineStyle: { color: '#3498db', width: 1 }, itemStyle: { color: '#3498db' } },
      { name: 'DEA', type: 'line', xAxisIndex: 1, yAxisIndex: 1, data: dea, smooth: false, symbol: 'none',
        lineStyle: { color: '#e74c3c', width: 1 }, itemStyle: { color: '#e74c3c' } },
      { name: 'K', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: kLine, smooth: false, symbol: 'none',
        lineStyle: { color: '#3498db', width: 1 }, itemStyle: { color: '#3498db' },
        markLine: { silent: true, symbol: 'none',
          data: [
            { yAxis: 10, lineStyle: { color: '#e74c3c', type: 'dashed', width: 1 },
              label: { show: true, position: 'insideEndBottom', fontSize: 10, color: '#e74c3c', formatter: '10' } },
            { yAxis: 80, lineStyle: { color: '#ddd', type: 'dashed', width: 1 },
              label: { show: true, position: 'insideEndBottom', fontSize: 10, color: '#bbb', formatter: '80' } },
          ],
        },
      },
      { name: 'D', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: dLine, smooth: false, symbol: 'none',
        lineStyle: { color: '#f39c12', width: 1 }, itemStyle: { color: '#f39c12' } },
      { name: 'J', type: 'line', xAxisIndex: 2, yAxisIndex: 2, data: jLine, smooth: false, symbol: 'none',
        lineStyle: { color: '#9b59b6', width: 1 }, itemStyle: { color: '#9b59b6' } },
      { name: 'stop_loss_pct', type: 'line', xAxisIndex: 3, yAxisIndex: 3, data: stopLossPct, smooth: false, symbol: 'none',
        lineStyle: { color: '#e74c3c', width: 1 }, itemStyle: { color: '#e74c3c' } },
      { name: 'risk_reward_ratio', type: 'line', xAxisIndex: 3, yAxisIndex: 4, data: riskRewardRatio, smooth: false, symbol: 'none',
        lineStyle: { color: '#27ae60', width: 1 }, itemStyle: { color: '#27ae60' } },
    ],
  };

  chart.setOption(option);

  chart.setOption({
    graphic: [
      { type: 'text', id: 'ma-info', left: 74, top: 34, z: 100,
        style: { fill: '#555', fontSize: 11, fontFamily: _FONT(), rich: RICH_MA, text: buildMAText(fi) } },
      { type: 'text', id: 'macd-info', left: 74, top: '52.5%', z: 100,
        style: { fill: '#555', fontSize: 11, fontFamily: _FONT(), rich: RICH_MACD, text: buildMacdText(fi) } },
      { type: 'text', id: 'kdj-info', left: 74, top: '64.5%', z: 100,
        style: { fill: '#555', fontSize: 11, fontFamily: _FONT(), rich: RICH_KDJ, text: buildKdjText(fi) } },
      { type: 'text', id: 'stop-risk-info', left: 74, top: '82.5%', z: 100,
        style: { fill: '#555', fontSize: 11, fontFamily: _FONT(), rich: RICH_STOP_RISK, text: buildStopRiskText(fi) } },
    ],
  });

  chart.on('updateAxisPointer', function(e) {
    if (!e.axesInfo || !e.axesInfo.length) return;
    const idx = e.axesInfo[0].value;
    if (idx == null || idx < 0 || idx >= times.length) return;
    chart.setOption({
      graphic: [
        { id: 'ma-info',       style: { text: buildMAText(idx),       rich: RICH_MA       } },
        { id: 'macd-info',     style: { text: buildMacdText(idx),     rich: RICH_MACD    } },
        { id: 'kdj-info',      style: { text: buildKdjText(idx),      rich: RICH_KDJ     } },
        { id: 'stop-risk-info', style: { text: buildStopRiskText(idx), rich: RICH_STOP_RISK } },
      ],
    });
  });
}

// 显示 K 线图对话框
function showKlineDialog(btn) {
  const symbol    = btn.dataset.sym;
  const time      = btn.dataset.time;
  const direction = btn.dataset.dir;
  const symTxns   = allTxnData.filter(function(x) { return x.symbol === symbol; });

  document.getElementById('dlgTitle').textContent =
    symbol + '   ' + direction + ' @ ' + time;
  document.getElementById('klineDialog').style.display = 'flex';

  if (_klineChart) { _klineChart.dispose(); _klineChart = null; }
  _klineChart = echarts.init(document.getElementById('klineChart'));
  _klineChart.showLoading({ text: '加载 K 线数据…', maskColor: 'rgba(255,255,255,0.8)' });

  fetch('cache/1h_klines/' + symbol + '_1h.csv')
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status + ' – ' + symbol);
      return r.text();
    })
    .then(function(csvText) {
      const allRows = _parseCsvKlines(csvText);
      const klines  = _sliceKlineWindow(allRows, symTxns);
      _klineChart.hideLoading();
      requestAnimationFrame(function() {
        _renderKlineChart(_klineChart, klines, time, symTxns);
        _klineChart.resize();
      });
    })
    .catch(function(err) {
      _klineChart.hideLoading();
      alert('加载 K 线数据失败：' + err.message + '\n请确认 serve_report.py 正在运行。');
    });
}

// 关闭 K 线图对话框
function closeKlineDialog() {
  document.getElementById('klineDialog').style.display = 'none';
  if (_klineChart) { _klineChart.dispose(); _klineChart = null; }
}

// 窗口缩放时同步更新 K 线图尺寸
window.addEventListener('resize', function() {
  if (_klineChart) _klineChart.resize();
});

// 按 Esc 关闭 / 点击遮罩关闭
document.addEventListener('keydown', function(e) {
  if (e.key === 'Escape') closeKlineDialog();
});
document.getElementById('klineDialog').addEventListener('click', function(e) {
  if (e.target === this) closeKlineDialog();
});

// 导出全局
window.showKlineDialog = showKlineDialog;
window.closeKlineDialog = closeKlineDialog;
