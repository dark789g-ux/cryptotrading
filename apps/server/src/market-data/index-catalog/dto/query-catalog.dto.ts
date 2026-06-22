/**
 * 统一指数目录查询入参。
 *
 * GET /api/index-catalog?category=&q=
 * - category: 'market' | 'industry' | 'concept'，缺省返回三类合并
 * - q: name 模糊搜索（ILIKE）
 */
export type IndexCatalogCategory = 'market' | 'industry' | 'concept';

export class QueryCatalogDto {
  category?: IndexCatalogCategory;
  q?: string;
}
