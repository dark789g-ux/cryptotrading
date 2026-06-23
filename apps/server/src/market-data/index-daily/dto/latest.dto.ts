/**
 * GET /api/indices/latest?type=&q=&sort=&order=&page=&pageSize= 查询参数。
 *
 * - type: 'market' | 'industry' | 'concept' | 'sw'，缺省返回四类合并
 * - level: 申万层级（仅 type='sw' 生效，1/2/3 = 一/二/三级行业）
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
  | 'tradeDate'
  | 'pe'
  | 'pb';

export class QueryLatestDto {
  type?: 'market' | 'industry' | 'concept' | 'sw';
  /** 申万层级过滤（仅 type='sw' 时使用）：1=一级、2=二级、3=三级 */
  level?: 1 | 2 | 3;
  q?: string;
  sort?: IndexLatestSortField;
  order?: 'asc' | 'desc';
  page?: number;
  pageSize?: number;
}
