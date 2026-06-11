/**
 * list-fills-query.dto.ts
 *
 * fills 列表接口查询参数 DTO。所有字段均为 string（来自 query string），
 * 数值解析在 controller 层完成（仿 signal-stats list-trades-query.dto）。
 */
export class ListFillsQueryDto {
  /** 页码（1-based，默认 1）。 */
  page?: string;

  /** 每页条数（上限 500，默认 50）。 */
  pageSize?: string;

  /** 排序字段 key（对应 FILL_SORT_COLUMN_MAP 白名单），非法值回落默认排序。 */
  sortField?: string;

  /** 排序方向，'asc' 或 'desc'（默认 'asc'）。 */
  sortOrder?: 'asc' | 'desc';

  /** 成交状态精确匹配：'taken' / 'skipped'（其它值忽略）。 */
  status?: string;

  /** 源策略标签精确匹配（source_label）。 */
  sourceLabel?: string;

  /** 跳过原因精确匹配（白名单：already_held/slots_full/exposure_cap/cash_short）。 */
  skipReason?: string;

  /** 买入日下界（YYYYMMDD，字符串比较）。 */
  buyDateStart?: string;

  /** 买入日上界（YYYYMMDD，字符串比较）。 */
  buyDateEnd?: string;
}
