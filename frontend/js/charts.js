/* charts.js - Chart.js 图表渲染 */

let _pfSnapshots = [];
let _pfChartInstance = null;

function resetPortfolioZoom() {
  if (_pfChartInstance) {
    _pfChartInstance.resetZoom();
  }
}

const crosshairPlugin = {
  id: 'crosshair',
  afterDraw(chart) {
    if (!chart.tooltip._active || !chart.tooltip._active.length) return;
    const ctx = chart.ctx;
    const { top, bottom, left, right } = chart.chartArea;
    const pt = chart.tooltip._active[0];
    const x = pt.element.x;
    const y = pt.element.y;
    ctx.save();
    ctx.beginPath();
    ctx.setLineDash([4, 4]);
    ctx.strokeStyle = 'rgba(80,80,80,0.5)';
    ctx.lineWidth = 1;
    ctx.moveTo(x, top);  ctx.lineTo(x, bottom);
    ctx.moveTo(left, y); ctx.lineTo(right, y);
    ctx.stroke();
    ctx.restore();
  }
};

function renderPortfolioChart(labels, values, snapshots) {
  _pfSnapshots = snapshots || [];
  if (_pfChartInstance) {
    _pfChartInstance.destroy();
  }
  _pfChartInstance = new Chart(document.getElementById('pfChart'), {
    type: 'line',
    data: {
      labels: labels,
      datasets: [{
        label: '账户净值 (USDT)',
        data: values,
        borderColor: '#3498db',
        backgroundColor: 'rgba(52,152,219,.08)',
        borderWidth: 1.5,
        pointRadius: 0,
        tension: 0.3,
        fill: true,
      }]
    },
    plugins: [crosshairPlugin],
    options: {
      responsive: true,
      maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      plugins: {
        legend: { display: false },
        zoom: {
          pan: {
            enabled: true,
            mode: 'x',
            modifierKey: null
          },
          zoom: {
            wheel: { enabled: true },
            drag: { enabled: true, backgroundColor: 'rgba(52,152,219,0.2)' },
            pinch: { enabled: true },
            mode: 'x'
          },
          limits: {
            x: { min: 0, max: 'original', minRange: 10 }
          }
        },
        tooltip: {
          callbacks: {
            label: function(item) {
              return '净值: ' + Math.round(item.raw).toLocaleString() + ' USDT';
            },
            footer: function(items) {
              const idx  = items[0].dataIndex;
              const ts   = items[0].label;
              const snap = _pfSnapshots[idx];
              const lines = [];

              // 本K线发生的交易
              const txns = (typeof allTxnData !== 'undefined' && allTxnData.length)
                ? allTxnData.filter(function(x) { return x.time === ts; })
                : [];
              if (txns.length) {
                lines.push('── 本K交易 ' + txns.length + ' 笔 ──');
                txns.forEach(function(x) {
                  const arrow = x.direction === '买入' ? '▶买入' : '◀卖出';
                  const rsn = x.reason ? x.reason.split('\n')[0] : '';
                  lines.push(arrow + ' ' + x.symbol
                    + '  @' + x.price
                    + (rsn ? '  [' + rsn + ']' : ''));
                });
              }

              // 本K收盘后持仓快照
              if (!snap || !snap.length) {
                lines.push('── 无持仓 ──');
              } else {
                lines.push('── 持仓 ' + snap.length + ' 个 ──');
                snap.forEach(function(s) {
                  const sign = s.pnl_pct >= 0 ? '+' : '';
                  const pnl  = sign + s.pnl_pct.toFixed(2) + '%';
                  const date = s.entry_time ? s.entry_time.slice(0, 16) : '-';
                  lines.push(
                    s.symbol
                    + '  开仓 ' + date
                    + '  持有 ' + s.hold_h + 'h'
                    + '  ' + pnl
                  );
                });
              }
              return lines;
            }
          },
          footerColor: '#f0a500',
          footerFont: { size: 11, family: '"Segoe UI","Microsoft YaHei",sans-serif' },
          footerMarginTop: 8,
        }
      },
      scales: {
        x: { ticks: { maxTicksLimit: 12, maxRotation: 30 } },
        y: { ticks: { callback: function(v) { return v.toLocaleString(); } } }
      }
    }
  });
}

function renderMonthlyChart(labels, values) {
  const colors = values.map(v => v >= 0 ? 'rgba(39,174,96,.75)' : 'rgba(231,76,60,.75)');
  new Chart(document.getElementById('monthChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: '月度收益率 (%)', data: values, backgroundColor: colors, borderRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { maxRotation: 45 } }, y: { ticks: { callback: v => v + '%' } } }
    }
  });
}

function renderSymbolsChart(labels, values) {
  const colors = values.map(v => v >= 0 ? 'rgba(39,174,96,.75)' : 'rgba(231,76,60,.75)');
  new Chart(document.getElementById('symChart'), {
    type: 'bar',
    data: { labels, datasets: [{ label: '盈亏 (USDT)', data: values, backgroundColor: colors, borderRadius: 3 }] },
    options: {
      responsive: true, maintainAspectRatio: false,
      indexAxis: 'y',
      plugins: { legend: { display: false } },
      scales: { x: { ticks: { callback: v => v.toFixed(0) } } }
    }
  });
}

// 导出全局
window.renderPortfolioChart = renderPortfolioChart;
window.renderMonthlyChart = renderMonthlyChart;
window.renderSymbolsChart = renderSymbolsChart;
window.resetPortfolioZoom = resetPortfolioZoom;
