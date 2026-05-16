/**
 * GET /ths-index-daily?ts_code=…&start_date=…&end_date=… 查询参数。
 */
export class ThsIndexDailyQueryDto {
  /** 同花顺指数代码，如 881101.TI */
  ts_code: string;
  /** 起始日期 YYYYMMDD（含） */
  start_date: string;
  /** 结束日期 YYYYMMDD（含） */
  end_date: string;
}
