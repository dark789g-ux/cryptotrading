export class QueryMemberDto {
	/** 行业/板块的 THS 指数代码（如 881101.TI） */
	ts_code!: string;

	/**
	 * 可选交易日（YYYYMMDD，8 位数字）；传入则 LEFT JOIN money_flow_stocks 携带 pct_change/net_amount。
	 *
	 * 说明：项目尚未引入 class-validator，校验在 controller 中通过 TRADE_DATE_PATTERN 完成；
	 * 若后续引入 class-validator，可改为 `@IsOptional() @Matches(/^\d{8}$/)`。
	 */
	trade_date?: string;
}

/** 8 位 YYYYMMDD 校验正则，供 controller 在接收 trade_date 时做运行时校验 */
export const TRADE_DATE_PATTERN = /^\d{8}$/;
