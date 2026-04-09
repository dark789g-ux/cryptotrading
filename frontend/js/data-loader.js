/* data-loader.js - 数据加载与初始化 */

let allTxnData = [];
let allPositionsData = [];
let allSymbolsData = [];
let currentRunId = '';

function _dataUrl(runId) {
  return runId
    ? 'backtest_results/' + runId + '/report_data.json'
    : 'backtest_results/report_data.json';
}

function _showError(msg) {
  document.getElementById('loading').innerHTML =
    '⚠ 无法加载数据：' + msg +
    '<br><br><small>请通过 <code>python serve_report.py</code> 启动本地服务器后访问，' +
    '不能直接双击打开 HTML 文件。</small>';
}

function loadRun(runId) {
  currentRunId = runId;
  document.getElementById('loading').style.display = 'block';
  document.getElementById('loading').textContent   = '⏳ 数据加载中…';
  document.getElementById('mainContent').style.display = 'none';

  fetch(_dataUrl(runId))
    .then(function(r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.json();
    })
    .then(function(data) {
      renderAll(data);
      document.getElementById('loading').style.display  = 'none';
      document.getElementById('mainContent').style.display = 'block';

      // 更新选择栏摘要信息
      var hint = document.getElementById('runHint');
      if (hint && data.stats) {
        var ret = data.stats['总收益率'] || '';
        var dd  = data.stats['最大回撤'] || '';
        var wr  = data.stats['胜率(完整出场)'] || '';
        hint.textContent = [ret && ('收益 ' + ret), dd && ('回撤 ' + dd), wr && ('胜率 ' + wr)]
          .filter(Boolean).join('   ');
      }
    })
    .catch(function(err) { _showError(err.message); });
}

function onRunSelect() {
  var sel = document.getElementById('runSelect');
  if (sel) loadRun(sel.value);
}

// 初始化：拉取回测记录列表
function initDataLoader() {
  fetch('/api/runs')
    .then(function(r) { return r.ok ? r.json() : []; })
    .catch(function()  { return []; })
    .then(function(runs) {
      var bar = document.getElementById('runBar');
      var sel = document.getElementById('runSelect');

      if (runs && runs.length > 0) {
        sel.innerHTML = runs.map(function(r) {
          var label = r.run_time;
          if (r.total_return) label += '  |  ' + r.total_return;
          if (r.win_rate)     label += '  胜率:' + r.win_rate;
          return '<option value="' + r.run_id + '">' + label + '</option>';
        }).join('');

        if (bar) bar.style.display = 'flex';
        loadRun(runs[0].run_id);
      } else {
        if (bar) bar.style.display = 'none';
        loadRun('');
      }
    });
}

function renderAll(data) {
  renderStats(data.stats);
  renderPortfolioChart(data.portfolio.labels, data.portfolio.values, data.portfolio.snapshots || []);
  renderMonthlyChart(data.monthly.labels, data.monthly.values);
  renderSymbolsChart(data.symbols_pnl.labels, data.symbols_pnl.values);

  allTxnData = data.transactions || [];
  document.getElementById('tab-btn-txn').textContent =
    '交易明细（' + allTxnData.length + ' 条）';
  renderTxnTable(1);

  allPositionsData = data.positions || [];
  initPosFilters(allPositionsData);
  document.getElementById('tab-btn-pos').textContent =
    '仓位明细（' + (data.total_positions || 0) + ' 个仓位）';
  renderTradesTable(1);

  allSymbolsData = data.symbols || [];
  document.getElementById('tab-btn-sym').textContent =
    '交易对明细（' + allSymbolsData.length + ' 个）';
  renderSymTable(1);
}

function renderStats(stats) {
  document.getElementById('statsTable').innerHTML =
    Object.entries(stats).map(function(entry) {
      return '<tr><td>' + entry[0] + '</td><td><strong>' + entry[1] + '</strong></td></tr>';
    }).join('');
}

// 导出全局
window.allTxnData = allTxnData;
window.allPositionsData = allPositionsData;
window.allSymbolsData = allSymbolsData;
window.loadRun = loadRun;
window.onRunSelect = onRunSelect;
window.initDataLoader = initDataLoader;
window.renderAll = renderAll;
window.renderStats = renderStats;
