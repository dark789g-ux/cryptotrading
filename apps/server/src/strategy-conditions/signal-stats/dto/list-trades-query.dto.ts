/**
 * list-trades-query.dto.ts
 *
 * 逐笔明细列表接口查询参数 DTO。
 * 所有字段均为 string（来自 query string），数值解析在 controller 层完成。
 */
export class ListTradesQueryDto {
  /** 页码（1-based，默认 1） */
  page?: string;

  /** 每页条数（上限 500，默认 50） */
  pageSize?: string;

  /** 排序字段 key（对应 SORT_COLUMN_MAP 白名单中的键），非法值回落默认排序 */
  sortField?: string;

  /** 排序方向，'asc' 或 'desc'（默认 'asc'） */
  sortOrder?: 'asc' | 'desc';

  /** 标的代码模糊匹配（ILike %...%） */
  tsCode?: string;

  /**
   * 出场原因精确匹配（白名单：max_hold/signal/delist/stop/ma5_exit），
   * 非白名单值忽略（不设过滤）
   */
  exitReason?: string;

  /** 收益率下界（小数，前端已将百分比 ÷100） */
  retMin?: string;

  /** 收益率上界 */
  retMax?: string;

  /** 持仓天数下界（整数） */
  holdDaysMin?: string;

  /** 持仓天数上界（整数） */
  holdDaysMax?: string;
}
