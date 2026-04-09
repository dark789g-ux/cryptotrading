/* transactions.js - 交易明细筛选、排序与分页 */

let _tfSymbol    = '', _tfTimeFrom = '', _tfTimeTo = '';
let _tfAmountMin = '', _tfAmountMax = '';
let _tfReason    = '';
let _tfDirs      = new Set();

const TXN_PER_PAGE  = 50;
const TXN_SORT_FIELDS = ['txn_no','symbol','time','price','amount','shares','direction'];
let txnSortKey = 'txn_no';
let txnSortDir = -1;

function toggleTxnDirFilter(btn) {
  const d = btn.dataset.dir;
  if (_tfDirs.has(d)) { _tfDirs.delete(d); btn.classList.remove('active'); }
  else                { _tfDirs.add(d);    btn.classList.add('active'); }
  renderTxnTable(1);
}

function onTxnFilter() {
  _tfSymbol    = document.getElementById('tf-symbol').value.trim().toLowerCase();
  _tfTimeFrom  = document.getElementById('tf-time-from').value;
  _tfTimeTo    = document.getElementById('tf-time-to').value;
  _tfAmountMin = document.getElementById('tf-amount-min').value;
  _tfAmountMax = document.getElementById('tf-amount-max').value;
  _tfReason    = document.getElementById('tf-reason').value.trim().toLowerCase();
  renderTxnTable(1);
}

function resetTxnFilters() {
  ['tf-symbol','tf-time-from','tf-time-to','tf-amount-min','tf-amount-max','tf-reason']
    .forEach(function(id) { document.getElementById(id).value = ''; });
  _tfSymbol = _tfTimeFrom = _tfTimeTo = _tfAmountMin = _tfAmountMax = _tfReason = '';
  _tfDirs.clear();
  document.querySelectorAll('#tab-txn .filter-tag-btn').forEach(function(b) {
    b.classList.remove('active');
  });
  renderTxnTable(1);
}

function applyTxnFilters(data) {
  return data.filter(function(x) {
    if (_tfSymbol && !x.symbol.toLowerCase().includes(_tfSymbol)) return false;
    const td = x.time ? x.time.slice(0, 10) : '';
    if (_tfTimeFrom && td < _tfTimeFrom) return false;
    if (_tfTimeTo   && td > _tfTimeTo)   return false;
    if (_tfDirs.size > 0 && !_tfDirs.has(x.direction)) return false;
    if (_tfAmountMin !== '' && x.amount < parseFloat(_tfAmountMin)) return false;
    if (_tfAmountMax !== '' && x.amount > parseFloat(_tfAmountMax)) return false;
    if (_tfReason && !(x.reason || '').toLowerCase().includes(_tfReason)) return false;
    return true;
  });
}

function txnSortBy(key) {
  if (txnSortKey === key) { txnSortDir = -txnSortDir; }
  else { txnSortKey = key; txnSortDir = -1; }
  renderTxnTable(1);
}

function getTxnSorted() {
  return applyTxnFilters(allTxnData).sort(function(a, b) {
    const va = (txnSortKey === 'price' || txnSortKey === 'amount') ? parseFloat(a[txnSortKey]) : a[txnSortKey];
    const vb = (txnSortKey === 'price' || txnSortKey === 'amount') ? parseFloat(b[txnSortKey]) : b[txnSortKey];
    if (va < vb) return txnSortDir;
    if (va > vb) return -txnSortDir;
    return 0;
  });
}

function updateTxnSortIcons() {
  TXN_SORT_FIELDS.forEach(function(k) {
    const el = document.getElementById('txn-sico-' + k);
    if (el) el.textContent = k === txnSortKey ? (txnSortDir === 1 ? '▲' : '▼') : '⇅';
  });
}

function renderTxnTable(page) {
  const sorted     = getTxnSorted();
  const total      = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / TXN_PER_PAGE));
  page = Math.max(1, Math.min(page, totalPages));
  const slice = sorted.slice((page - 1) * TXN_PER_PAGE, page * TXN_PER_PAGE);

  document.getElementById('txnTbody').innerHTML = slice.map(function(x) {
    const c = x.direction === '买入' ? '#2980b9' : '#e74c3c';
    return '<tr>'
      + '<td>' + x.txn_no + '</td>'
      + '<td>' + x.symbol + '</td>'
      + '<td>' + x.time + '</td>'
      + '<td>' + x.price + '</td>'
      + '<td>' + x.amount.toFixed(2) + '</td>'
      + '<td>' + x.shares + '</td>'
      + '<td style="color:' + c + ';font-weight:bold">' + x.direction + '</td>'
      + '<td style="color:#888;font-size:.78rem;white-space:normal;min-width:180px">'
          + (x.reason ? x.reason.replace(/\n/g, '<br>') : '-')
          + '</td>'
      + '<td><button class="btn-view" data-sym="' + x.symbol
          + '" data-time="' + x.time
          + '" data-dir="' + x.direction
          + '" onclick="showKlineDialog(this)">查看</button></td>'
      + '</tr>';
  }).join('');

  updateTxnSortIcons();

  const hint = document.getElementById('tf-result-hint');
  if (hint) {
    hint.textContent = total < allTxnData.length
      ? '筛选结果：' + total + ' / ' + allTxnData.length + ' 条' : '';
  }

  document.getElementById('txnPagination').innerHTML = renderPagination(
    page, totalPages, total, 'renderTxnTable', TXN_PER_PAGE
  );
}

// 导出全局
window.toggleTxnDirFilter = toggleTxnDirFilter;
window.onTxnFilter = onTxnFilter;
window.resetTxnFilters = resetTxnFilters;
window.txnSortBy = txnSortBy;
window.renderTxnTable = renderTxnTable;
window.TXN_PER_PAGE = TXN_PER_PAGE;
window.txnSortKey = txnSortKey;
window.txnSortDir = txnSortDir;
