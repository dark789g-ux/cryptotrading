/**
 * POST /api/one-click-sync/runs 请求体。
 *
 * 字段名与前端逐字一致（camelCase startDate/endDate，YYYYMMDD）。
 * 项目无全局 ValidationPipe，校验在 controller 手动做（8 位 YYYYMMDD + start<=end）。
 */
export class CreateRunDto {
  /** 起始交易日，8 位 YYYYMMDD */
  startDate: string;
  /** 结束交易日，8 位 YYYYMMDD */
  endDate: string;
}
