/**
 * GET /api/index-daily?ts_code=&start_date=&end_date= 查询参数。
 *
 * 契约与 /api/ths-index-daily 对齐（ts_code + start_date + end_date，
 * 均 YYYYMMDD）。区别：此路由查统一表 index_daily_quotes，支持大盘 / 行业 / 概念
 * 全部 category；旧路由薄封装仅 industry/concept。
 */
export class QueryKlineDto {
  /** 指数代码，如 000001.SH / 881101.TI */
  ts_code: string;
  /** 起始日期 YYYYMMDD（含） */
  start_date: string;
  /** 结束日期 YYYYMMDD（含） */
  end_date: string;
}
