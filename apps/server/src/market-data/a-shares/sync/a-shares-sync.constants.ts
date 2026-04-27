export const STOCK_BASIC_FIELDS = [
  'ts_code',
  'symbol',
  'name',
  'area',
  'industry',
  'market',
  'exchange',
  'list_status',
  'list_date',
  'delist_date',
  'is_hs',
].join(',');

export const DAILY_FIELDS = [
  'ts_code',
  'trade_date',
  'open',
  'high',
  'low',
  'close',
  'pre_close',
  'change',
  'pct_chg',
  'vol',
  'amount',
].join(',');

export const DAILY_BASIC_FIELDS = [
  'ts_code',
  'trade_date',
  'turnover_rate',
  'volume_ratio',
  'pe',
  'pe_ttm',
  'pb',
  'total_mv',
  'circ_mv',
].join(',');

export const ADJ_FACTOR_FIELDS = [
  'ts_code',
  'trade_date',
  'adj_factor',
].join(',');
