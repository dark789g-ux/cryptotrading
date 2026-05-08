export class QueryFlowDto {
  /** 单日查询（YYYYMMDD），与 start_date/end_date 互斥 */
  trade_date?: string;
  start_date?: string;
  end_date?: string;
  /** 按实体代码过滤（个股 ts_code、行业 ts_code、板块 ts_code） */
  ts_code?: string;
}
