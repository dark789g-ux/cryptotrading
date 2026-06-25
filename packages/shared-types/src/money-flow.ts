/** money-flow 高级筛选条件（POST body 透传到后端） */
export type MoneyFlowConditionOp = 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq'
export type MoneyFlowNumberCondition = {
  field: string
  op: MoneyFlowConditionOp
  valueType?: 'number'
  value: number
}
export type MoneyFlowFieldCondition = {
  field: string
  op: MoneyFlowConditionOp
  valueType: 'field'
  compareField: string
}
export type MoneyFlowCondition = MoneyFlowNumberCondition | MoneyFlowFieldCondition

/** /money-flow/* 查询参数（GET 用日期/标的，POST industries/query 复用同结构 + 过滤字段） */
export interface MoneyFlowQueryParams {
  trade_date?: string
  start_date?: string
  end_date?: string
  ts_code?: string
  limit?: number
  /** 行业名模糊匹配（仅 industries/query） */
  industry?: string
  /** 涨跌幅 % 区间（仅 industries/query） */
  pct_change_min?: number
  pct_change_max?: number
  /** 净流入下限，单位与 DB 列一致（万元）；前端需自行将"亿"× 1e4 后传入 */
  net_amount_min?: number
  /** 净买入下限（万元） */
  net_buy_amount_min?: number
  /** 净卖出下限（万元） */
  net_sell_amount_min?: number
  /** 高级筛选条件数组（仅 industries/query） */
  conditions?: MoneyFlowCondition[]
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
  swIndustry: string | null
  thsIndustry: string | null
  sector: string | null
  market: string | null
  index: string | null
}

/** GET /money-flow/indices 单行（moneyflow_index_ths，指数资金流向） */
export interface MoneyFlowIndexRow {
  id: string
  tsCode: string
  tradeDate: string
  name: string | null
  netAmount: string | null
  buyLgAmount: string | null
  buyMdAmount: string | null
  buySmAmount: string | null
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

/** GET /money-flow/members 单行（ths_member_stocks 成分股映射，可选附加当日资金流字段） */
export interface MoneyFlowMemberRow {
  tsCode: string
  conCode: string
  conName: string | null
  isNew: string | null
  /** 当日涨跌幅（百分比原值），未传 trade_date 或停牌为 null */
  pctChange: number | null
  /** 当日净流入（亿元，已 ÷10000），未传 trade_date 或停牌为 null */
  netAmount: number | null
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
  swIndustries: MoneyFlowSyncResult
  thsIndustries: MoneyFlowSyncResult
  sectors: MoneyFlowSyncResult
  market: MoneyFlowSyncResult
  indices: MoneyFlowSyncResult
}

export interface IndexCatalogSyncSummary {
  industryCatalog: MoneyFlowSyncResult
  conceptCatalog:  MoneyFlowSyncResult
  industryMembers: MoneyFlowSyncResult
  conceptMembers:  MoneyFlowSyncResult
  cleanup:         MoneyFlowSyncResult
}
