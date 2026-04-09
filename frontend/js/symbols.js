/* symbols.js - 交易对明细筛选、排序与分页 */

let _sfSymbol  = '', _sfPnlMin  = '', _sfPnlMax  = '';
let _sfWrMin   = '', _sfWrMax   = '';
let _sfCntMin  = '', _sfCntMax  = '';

const SYM_PER_PAGE   = 50;
const SYM_SORT_FIELDS = ['symbol','pos_count','win_rate','total_pnl','total_buy',
                         'avg_return','best_return','worst_return','avg_hold',
                         'half_count','first_entry','last_entry'];
let symSortKey = 'total_pnl';
let symSortDir = -1;

function onSymFilter() {
  _sfSymbol = document.getElementById('sf-symbol').value.trim().toLowerCase();
  _sfPnlMin = document.getElementById('sf-pnl-min').value;
  _sfPnlMax = document.getElementById('sf-pnl-max').value;
  _sfWrMin  = document.getElementById('sf-wr-min').value;
  _sfWrMax  = document.getElementById('sf-wr-max').value;
  _sfCntMin = document.getElementById('sf-cnt-min').value;
  _sfCntMax = document.getElementById('sf-cnt-max').value;
  renderSymTable(1);
}

function resetSymFilters() {
  ['sf-symbol','sf-pnl-min','sf-pnl-max','sf-wr-min','sf-wr-max','sf-cnt-min','sf-cnt-max']
    .forEach(function(id) { document.getElementById(id).value = ''; });
  _sfSymbol = _sfPnlMin = _sfPnlMax = _sfWrMin = _sfWrMax = _sfCntMin = _sfCntMax = '';
  renderSymTable(1);
}

function applySymFilters(data) {
  return data.filter(function(s) {
    if (_sfSymbol && !s.symbol.toLowerCase().includes(_sfSymbol)) return false;
    if (_sfPnlMin !== '' && s.total_pnl  < parseFloat(_sfPnlMin)) return false;
    if (_sfPnlMax !== '' && s.total_pnl  > parseFloat(_sfPnlMax)) return false;
    if (_sfWrMin  !== '' && s.win_rate   < parseFloat(_sfWrMin))  return false;
    if (_sfWrMax  !== '' && s.win_rate   > parseFloat(_sfWrMax))  return false;
    if (_sfCntMin !== '' && s.pos_count  < parseInt(_sfCntMin))   return false;
    if (_sfCntMax !== '' && s.pos_count  > parseInt(_sfCntMax))   return false;
    return true;
  });
}

function symSortBy(key) {
  if (symSortKey === key) { symSortDir = -symSortDir; }
  else { symSortKey = key; symSortDir = -1; }
  renderSymTable(1);
}

function getSymSorted() {
  return applySymFilters(allSymbolsData).sort(function(a, b) {
    const va = a[symSortKey];
    const vb = b[symSortKey];
    if (va < vb) return symSortDir;
    if (va > vb) return -symSortDir;
    return 0;
  });
}

function updateSymSortIcons() {
  SYM_SORT_FIELDS.forEach(function(k) {
    const el = document.getElementById('sym-sico-' + k);
    if (el) el.textContent = k === symSortKey ? (symSortDir === 1 ? '▲' : '▼') : '⇅';
  });
}

function renderSymTable(page) {
  const sorted     = getSymSorted();
  const total      = sorted.length;
  const totalPages = Math.max(1, Math.ceil(total / SYM_PER_PAGE));
  page = Math.max(1, Math.min(page, totalPages));
  const slice = sorted.slice((page - 1) * SYM_PER_PAGE, page * SYM_PER_PAGE);

  function retCell(v) {
    const c = v >= 0 ? '#27ae60' : '#e74c3c';
    return '<td style="color:' + c + '">' + (v >= 0 ? '+' : '') + v.toFixed(2) + '%</td>';
  }

  document.getElementById('symTbody').innerHTML = slice.map(function(s) {
    const pc  = s.total_pnl >= 0 ? '#27ae60' : '#e74c3c';
    const pnl = (s.total_pnl >= 0 ? '+' : '') + s.total_pnl.toFixed(2);
    return '<tr>'
      + '<td>' + s.symbol + '</td>'
      + '<td>' + s.pos_count + '</td>'
      + '<td>' + s.win_rate.toFixed(1) + '%</td>'
      + '<td style="color:' + pc + '">' + pnl + '</td>'
      + '<td>' + s.total_buy.toFixed(2) + '</td>'
      + retCell(s.avg_return)
      + retCell(s.best_return)
      + retCell(s.worst_return)
      + '<td>' + s.avg_hold.toFixed(1) + '</td>'
      + '<td>' + s.half_count + '</td>'
      + '<td>' + (s.first_entry ? s.first_entry.slice(0, 10) : '-') + '</td>'
      + '<td>' + (s.last_entry  ? s.last_entry.slice(0, 10)  : '-') + '</td>'
      + '<td><button class="btn-view" data-sym="' + s.symbol
          + '" data-time="' + (s.last_entry || '')
          + '" data-dir="买入"'
          + ' onclick="showKlineDialog(this)">查看</button></td>'
      + '</tr>';
  }).join('');

  updateSymSortIcons();

  const hint = document.getElementById('sf-result-hint');
  if (hint) {
    hint.textContent = total < allSymbolsData.length
      ? '筛选结果：' + total + ' / ' + allSymbolsData.length + ' 个' : '';
  }

  document.getElementById('symPagination').innerHTML = renderPagination(
    page, totalPages, total, 'renderSymTable', SYM_PER_PAGE
  );
}

// 导出全局
window.onSymFilter = onSymFilter;
window.resetSymFilters = resetSymFilters;
window.symSortBy = symSortBy;
window.renderSymTable = renderSymTable;
window.SYM_PER_PAGE = SYM_PER_PAGE;
window.symSortKey = symSortKey;
window.symSortDir = symSortDir;
window.SYM_SORT_FIELDS = SYM_SORT_FIELDS;
