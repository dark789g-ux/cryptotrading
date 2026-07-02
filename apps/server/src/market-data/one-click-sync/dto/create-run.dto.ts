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

  /**
   * 同步模式：'incremental'（默认，跳过已有 trade_date）| 'overwrite'（重拉范围内日期，覆盖写入）。
   * 不持久化到 run entity；仅作参数透传给各 step runner（ctx.syncMode）。
   */
  syncMode?: 'incremental' | 'overwrite';

  /**
   * 按需勾选的 step key 集合（对应 STEP_ORDER 中的 OneClickStepKey）。
   * 空/缺省 = 全选（兼容旧请求 + 默认全勾）；非空时未列入的 step 标 skipped 不执行。
   * 不持久化到 run entity。
   */
  selectedSteps?: string[];
}
