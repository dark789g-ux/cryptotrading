/** GET /money-flow/* 查询参数 */
export interface MoneyFlowQueryParams {
  trade_date?: string
  start_date?: string
  end_date?: string
  ts_code?: string
  limit?: number
}

/** POST /money-flow/sync/* 同步参数 */
export interface MoneyFlowSyncParams {
  start_date: string
  end_date: string
}

/** 同步任务返回结果 */
export interface MoneyFlowSyncResult {
  success: number
  skipped: number
  errors: string[]
}

/** GET /money-flow/latest-dates */
export interface MoneyFlowLatestDates {
  stock: string | null
  industry: string | null
  sector: string | null
  market: string | null
}

/** GET /money-flow/stocks 单行 */
export interface MoneyFlowStockRow {
  id: string
  tsCode: string
  tradeDate: string
  name: string | null
  pctChange: string | null
  latest: string | null
  netAmount: string | null
  netD5Amount: string | null
  buyLgAmount: string | null
  buyLgAmountRate: string | null
  buyMdAmount: string | null
  buyMdAmountRate: string | null
  buySmAmount: string | null
  buySmAmountRate: string | null
}

/** GET /money-flow/industries 单行（moneyflow_ind_ths，无大中小单拆分） */
export interface MoneyFlowIndustryRow {
  id: string
  tsCode: string
  tradeDate: string
  industry: string
  pctChange: string | null
  netBuyAmount: string | null
  netSellAmount: string | null
  netAmount: string | null
}

/** GET /money-flow/sectors 单行（moneyflow_cnt_ths，无大中小单拆分） */
export interface MoneyFlowSectorRow {
  id: string
  tsCode: string
  tradeDate: string
  sector: string
  pctChange: string | null
  netBuyAmount: string | null
  netSellAmount: string | null
  netAmount: string | null
}

/** GET /money-flow/market 单行（数据源：moneyflow_mkt_dc，东方财富大盘资金流向） */
export interface MoneyFlowMarketRow {
  id: string
  tradeDate: string
  netAmount: string | null
  buyLgAmount: string | null
  buySmAmount: string | null
}
