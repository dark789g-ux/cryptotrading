/* utils.js - 通用工具函数 */

// 格式化数值
function fv(v, d) {
  return (v != null && !isNaN(+v)) ? (+v).toFixed(d !== undefined ? d : 4) : '-';
}

// 按有效数字位数格式化（用于 MACD/BBI/ATR 等可能极小的指标值）
function fsig(v, sig) {
  if (v == null || isNaN(+v)) return '-';
  const x = +v;
  if (x === 0) return '0';
  sig = (sig !== undefined) ? sig : 4;
  const magnitude = Math.floor(Math.log10(Math.abs(x)));
  const decPlaces = Math.max(sig - 1 - magnitude, 0);
  return x.toFixed(decPlaces);
}

// 趋势箭头
function trend(curr, prev) {
  if (curr == null || prev == null || isNaN(+curr) || isNaN(+prev)) return '';
  const c = +curr, p = +prev;
  if (c > p + 1e-10) return ' ↑';
  if (c < p - 1e-10) return ' ↓';
  return ' →';
}

// 数组索引安全获取
function clampIdx(idx, arr) {
  return Math.max(0, Math.min(idx, arr.length - 1));
}

// 分页组件 HTML 生成
function renderPagination(page, totalPages, total, onPageClick, pageSize) {
  let pg = '<span class="page-info">共 ' + total + ' 条，第 ' + page + ' / ' + totalPages + ' 页</span>';
  pg += '<button onclick="' + onPageClick + '(1)"' + (page === 1 ? ' disabled' : '') + '>«</button>';
  pg += '<button onclick="' + onPageClick + '(' + (page - 1) + ')"' + (page === 1 ? ' disabled' : '') + '>‹</button>';
  const s = Math.max(1, page - 2);
  const e = Math.min(totalPages, s + 4);
  for (let p = s; p <= e; p++) {
    pg += '<button onclick="' + onPageClick + '(' + p + ')"' + (p === page ? ' class="active"' : '') + '>' + p + '</button>';
  }
  pg += '<button onclick="' + onPageClick + '(' + (page + 1) + ')"' + (page === totalPages ? ' disabled' : '') + '>›</button>';
  pg += '<button onclick="' + onPageClick + '(' + totalPages + ')"' + (page === totalPages ? ' disabled' : '') + '>»</button>';
  return pg;
}

// Tab 切换
function switchTab(name) {
  ['pos', 'txn', 'sym'].forEach(function(t) {
    document.getElementById('tab-' + t).classList.toggle('active', t === name);
    document.getElementById('tab-btn-' + t).classList.toggle('active', t === name);
  });
}

// 导出全局
window.fv = fv;
window.fsig = fsig;
window.trend = trend;
window.clampIdx = clampIdx;
window.renderPagination = renderPagination;
window.switchTab = switchTab;
