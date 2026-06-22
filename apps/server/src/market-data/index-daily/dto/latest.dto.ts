/**
 * GET /api/indices/latest?type=&q=&sort=&order=&page=&pageSize= 查询参数。
 *
 * - type: 'market' | 'industry' | 'concept'，缺省返回三类合并
 * - q: name 模糊搜索（ILIKE，大小写不敏感）
 * - sort: 排序字段，默认 pct_change
 * - order: 'asc' | 'desc'，默认 desc
 * - page / pageSize: 远程分页（1-based）
 */
export type IndexLatestSortField =
  | 'pct_change'
  | 'vol'
  | 'amount'
  | 'total_mv_wan'
  | 'tradeDate';

export class QueryLatestDto {
  type?: 'market' | 'industry' | 'concept';
  q?: string;
  sort?: IndexLatestSortField;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}
