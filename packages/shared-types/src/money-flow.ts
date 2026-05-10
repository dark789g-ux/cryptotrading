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
  syncMode?: 'incremental' | 'overwrite'
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

/** GET /money-flow/members 单行（ths_member_stocks 成分股映射） */
export interface MoneyFlowMemberRow {
  tsCode: string
  conCode: string
  conName: string | null
  isNew: string | null
}

/** SSE 事件 —— GET /money-flow/sync/run */
export type MoneyFlowSyncEvent =
  | {
      type: 'progress'
      percent: number
      phase: string
      current: number
      total: number
      message: string
    }
  | {
      type: 'done'
      message: string
      summary: MoneyFlowSyncSummary | IndexCatalogSyncSummary
    }
  | {
      type: 'error'
      message: string
      /** 错误发生时的部分进度摘要，便于前端展示已完成的维度 */
      summary?: Partial<MoneyFlowSyncSummary> | Partial<IndexCatalogSyncSummary>
    }

export interface MoneyFlowSyncSummary {
  stocks: MoneyFlowSyncResult
  industries: MoneyFlowSyncResult
  sectors: MoneyFlowSyncResult
  market: MoneyFlowSyncResult
}

export interface IndexCatalogSyncSummary {
  industryCatalog: MoneyFlowSyncResult
  conceptCatalog:  MoneyFlowSyncResult
  industryMembers: MoneyFlowSyncResult
  conceptMembers:  MoneyFlowSyncResult
  cleanup:         MoneyFlowSyncResult
}
