export class CreateReviewDto {
  /** 交易日 YYYYMMDD，不传则取最新 A 股交易日 */
  tradeDate?: string;
}
