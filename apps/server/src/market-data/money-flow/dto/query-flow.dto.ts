export class QueryFlowDto {
  /** 单日查询（YYYYMMDD），与 start_date/end_date 互斥 */
  trade_date?: string;
  start_date?: string;
  end_date?: string;
  /** 仅个股查询支持，过滤单只股票 */
  ts_code?: string;
}
