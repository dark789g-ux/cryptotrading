/* positions.js - 仓位明细筛选、排序与分页 */

let _pfSymbol    = '', _pfEntryFrom = '', _pfEntryTo   = '';
let _pfCloseFrom = '', _pfCloseTo   = '';
let _pfPnlMin    = '', _pfPnlMax    = '';
let _pfRetMin    = '', _pfRetMax    = '';
let _pfHoldMin   = '', _pfHoldMax   = '';
let _pfCntMin    = '', _pfCntMax    = '';
let _pfStopTypes = new Set();

const TRADES_PER_PAGE = 50;
const SORT_FIELDS = ['pos_no','symbol','entry_time','entry_price','buy_amount','buy_shares',
                     'close_time','sell_price','sell_amount',
                     'pnl','return_pct','hold_candles','trade_count'];
let sortKey = 'pos_no';
let sortDir = -1;

function initPosFilters(positions) {
  const allTypes = [];
  const seen = new Set();
  ['阶段止盈'].forEach(function(t) { seen.add(t); allTypes.push(t); });
  positions.forEach(function(p) {
    if (!p.stop_types) return;
    p.stop_types.forEach(function(t) {
      if (!seen.has(t)) { seen.add(t); allTypes.push(t); }
    });
  });
  document.getElementById('pf-stop-types').innerHTML = allTypes.map(function(t) {
    return '<button class="filter-tag-btn" data-type="' + t
         + '" onclick="toggleStopFilter(this)">' + t + '</button>';
  }).join('');
}

function toggleStopFilter(btn) {
  const t = btn.dataset.type;
  if (_pfStopTypes.has(t)) { _pfStopTypes.delete(t); btn.classList.remove('active'); }
  else                      { _pfStopTypes.add(t);    btn.classList.add('active'); }
  renderTradesTable(1);
}

function onPosFilter() {
  _pfSymbol    = document.getElementById('pf-symbol').value.trim().toLowerCase();
  _pfEntryFrom = document.getElementById('pf-entry-from').value;
  _pfEntryTo   = document.getElementById('pf-entry-to').value;
  _pfCloseFrom = document.getElementById('pf-close-from').value;
  _pfCloseTo   = document.getElementById('pf-close-to').value;
  _pfPnlMin    = document.getElementById('pf-pnl-min').value;
  _pfPnlMax    = document.getElementById('pf-pnl-max').value;
  _pfRetMin    = document.getElementById('pf-ret-min').value;
  _pfRetMax    = document.getElementById('pf-ret-max').value;
  _pfHoldMin   = document.getElementById('pf-hold-min').value;
  _pfHoldMax   = document.getElementById('pf-hold-max').value;
  _pfCntMin    = document.getElementById('pf-cnt-min').value;
  _pfCntMax    = document.getElementById('pf-cnt-max').value;
  renderTradesTable(1);
}

function resetPosFilters() {
  ['pf-symbol','pf-entry-from','pf-entry-to','pf-close-from','pf-close-to',
   'pf-pnl-min','pf-pnl-max','pf-ret-min','pf-ret-max',
   'pf-hold-min','pf-hold-max','pf-cnt-min','pf-cnt-max'].forEach(function(id) {
    document.getElementById(id).value = '';
  });
  _pfSymbol = _pfEntryFrom = _pfEntryTo = _pfCloseFrom = _pfCloseTo = '';
  _pfPnlMin = _pfPnlMax = _pfRetMin = _pfRetMax = '';
  _pfHoldMin = _pfHoldMax = _pfCntMin = _pfCntMax = '';
  _pfStopTypes.clear();
  document.querySelectorAll('#pf-stop-types .filter-tag-btn').forEach(function(b) {
    b.classList.remove('active');
  });
  renderTradesTable(1);
}

function applyPosFilters(data) {
  return data.filter(function(p) {
    if (_pfSymbol && !p.symbol.toLowerCase().includes(_pfSymbol)) return false;
    const ed = p.entry_time ? p.entry_time.slice(0, 10) : '';
    const cd = p.close_time ? p.close_time.slice(0, 10) : '';
    if (_pfEntryFrom && ed < _pfEntryFrom) return false;
    if (_pfEntryTo   && ed > _pfEntryTo)   return false;
    if (_pfCloseFrom && cd < _pfCloseFrom) return false;
    if (_pfCloseTo   && cd > _pfCloseTo)   return false;
    if (_pfPnlMin  !== '' && p.pnl          < parseFloat(_pfPnlMin))  return false;
    if (_pfPnlMax  !== '' && p.pnl          > parseFloat(_pfPnlMax))  return false;
    if (_pfRetMin  !== '' && p.return_pct   < parseFloat(_pfRetMin))  return false;
    if (_pfRetMax  !== '' && p.return_pct   > parseFloat(_pfRetMax))  return false;
    if (_pfHoldMin !== '' && p.hold_candles < parseInt(_pfHoldMin))   return false;
    if (_pfHoldMax !== '' && p.hold_candles > parseInt(_pfHoldMax))   return false;
    if (_pfCntMin  !== '' && p.trade_count  < parseInt(_pfCntMin))    return false;
    if (_pfCntMax  !== '' && p.trade_count  > parseInt(_pfCntMax))    return false;
    if (_pfStopTypes.size > 0) {
      const types = p.stop_types || [];
      if (!types.some(function(t) { return _pfStopTypes.has(t); })) return false;
    }
    return true;
  });
}

function getSortValue(t, key) {
  if (key === 'entry_price' || key === 'sell_price') return parseFloat(t[key]);
  return t[key];
}

function getSortedData() {
  return applyPosFilters(allPositionsData).sort(function(a, b) {
    const va = getSortValue(a, sortKey);
    const vb = getSortValue(b, sortKey);
    if (va < vb) return sortDir;
    if (va > vb) return -sortDir;
    return 0;
  });
}

function sortBy(key) {
  if (sortKey === key) { sortDir = -sortDir; }
  else { sortKey = key; sortDir = -1; }
  renderTradesTable(1);
}

function updateSortIcons() {
  SORT_FIELDS.forEach(function(k) {
    const el = document.getElementById('sico-' + k);
    if (el) el.textContent = k === sortKey ? (sortDir === 1 ? '▲' : '▼') : '⇅';
  });
}

function renderStopTypes(types) {
  if (!types || !types.length) return '-';
  return types.map(function(t) {
    var cls = t === '阶段止盈' ? 'stop-tag-profit'
            : t === '回测结束'  ? 'stop-tag-neutral'
            : 'stop-tag-loss';
    return '<span class="stop-tag ' + cls + '">' + t + '</span>';
  }).join('');
}

function renderTradesTable(page) {
  const sorted     = getSortedData();
  const total      = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / TRADES_PER_PAGE));
  page = Math.max(1, Math.min(page, totalPages));
  const slice = sorted.slice((page - 1) * TRADES_PER_PAGE, page * TRADES_PER_PAGE);

  document.getElementById('tradesTbody').innerHTML = slice.map(function(p) {
    const c   = p.pnl >= 0 ? '#27ae60' : '#e74c3c';
    const pnl = (p.pnl >= 0 ? '+' : '') + p.pnl.toFixed(2);
    const ret = (p.return_pct >= 0 ? '+' : '') + p.return_pct.toFixed(2) + '%';
    return '<tr>'
      + '<td>' + p.pos_no + '</td>'
      + '<td>' + p.symbol + '</td>'
      + '<td>' + p.entry_time + '</td>'
      + '<td>' + p.entry_price + '</td>'
      + '<td>' + p.buy_amount.toFixed(2) + '</td>'
      + '<td>' + p.buy_shares + '</td>'
      + '<td>' + p.close_time + '</td>'
      + '<td>' + p.sell_price + '</td>'
      + '<td>' + p.sell_amount.toFixed(2) + '</td>'
      + '<td style="color:' + c + '">' + pnl + '</td>'
      + '<td style="color:' + c + '">' + ret + '</td>'
      + '<td>' + p.hold_candles + '</td>'
      + '<td>' + p.trade_count + '</td>'
      + '<td style="white-space:normal;min-width:120px">' + renderStopTypes(p.stop_types) + '</td>'
      + '<td><button class="btn-view" data-sym="' + p.symbol
          + '" data-time="' + p.entry_time
          + '" data-dir="买入"'
          + ' onclick="showKlineDialog(this)">查看</button></td>'
      + '</tr>';
  }).join('');

  updateSortIcons();

  const hint = document.getElementById('pf-result-hint');
  if (hint) {
    hint.textContent = total < allPositionsData.length
      ? '筛选结果：' + total + ' / ' + allPositionsData.length + ' 个仓位' : '';
  }

  document.getElementById('tradesPagination').innerHTML = renderPagination(
    page, totalPages, total, 'renderTradesTable', TRADES_PER_PAGE
  );
}

// 导出全局
window.initPosFilters = initPosFilters;
window.toggleStopFilter = toggleStopFilter;
window.onPosFilter = onPosFilter;
window.resetPosFilters = resetPosFilters;
window.sortBy = sortBy;
window.renderTradesTable = renderTradesTable;
window.TRADES_PER_PAGE = TRADES_PER_PAGE;
window.sortKey = sortKey;
window.sortDir = sortDir;
window.SORT_FIELDS = SORT_FIELDS;
