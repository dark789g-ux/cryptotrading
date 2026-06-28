export type CustomIndexLatestSortField =
  | 'close'
  | 'pctChange'
  | 'vol'
  | 'amount'
  | 'tradeDate'
  | 'count'
  | 'netAmount'
  | 'netAmount5d'
  | 'netAmount10d'
  | 'netAmount20d'
  | 'updatedAt';

/** 表格 columnKey（snake_case）→ API sort 字段 */
const SORT_FIELD_ALIASES: Record<string, CustomIndexLatestSortField> = {
  close: 'close',
  pct_change: 'pctChange',
  vol: 'vol',
  amount: 'amount',
  trade_date: 'tradeDate',
  tradeDate: 'tradeDate',
  count: 'count',
  net_amount: 'netAmount',
  net_amount_5d: 'netAmount5d',
  net_amount_10d: 'netAmount10d',
  net_amount_20d: 'netAmount20d',
  netAmount: 'netAmount',
  netAmount5d: 'netAmount5d',
  netAmount10d: 'netAmount10d',
  netAmount20d: 'netAmount20d',
  updated_at: 'updatedAt',
  updatedAt: 'updatedAt',
  pctChange: 'pctChange',
};

export interface QueryCustomIndexLatestDto {
  q?: string;
  sort?: CustomIndexLatestSortField;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}

export function parseQueryCustomIndexLatest(query: Record<string, unknown>): QueryCustomIndexLatestDto {
  const sortWhitelist: CustomIndexLatestSortField[] = [
    'close',
    'pctChange',
    'vol',
    'amount',
    'tradeDate',
    'count',
    'netAmount',
    'netAmount5d',
    'netAmount10d',
    'netAmount20d',
    'updatedAt',
  ];
  const sortRaw = query.sort;
  const normalized =
    typeof sortRaw === 'string' ? SORT_FIELD_ALIASES[sortRaw] : undefined;
  const sort =
    normalized && sortWhitelist.includes(normalized) ? normalized : 'pctChange';

  const orderRaw = query.order;
  const order = orderRaw === 'asc' ? 'asc' : 'desc';

  const page = Math.max(1, Number(query.page ?? 1) || 1);
  const pageSize = Math.min(200, Math.max(1, Number(query.pageSize ?? 20) || 20));

  const q = typeof query.q === 'string' && query.q.trim() ? query.q.trim() : undefined;

  return { q, sort, order, page, pageSize };
}
