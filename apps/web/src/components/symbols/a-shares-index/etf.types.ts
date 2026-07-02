/**
 * ETF 列表行类型与查询结果。
 *
 * 对应后端 GET /api/etf/latest 返回结构（camelCase）。
 * 字段命名见 plan 字段映射表 + ASCII 线框图。
 */

/** GET /api/etf/latest 单行 */
export interface EtfLatestRow {
  tsCode: string
  name: string
  /** 跟踪指数代码（如有） */
  indexCode: string | null
  /** 管理人 */
  manager: string
  /**
   * 基金类型：fund_basic.fund_type 原值（股票型/债券型/货币型/QDII 等粗类）。
   * R4 方案 C：不细分单/跨市场（fund_basic 无此能力），原值直存，前端动态生成筛选。
   */
  fundType: string | null
  /** 最新交易日 YYYYMMDD */
  tradeDate: string
  /** 收盘价 */
  close: number | null
  /** 涨跌幅(%) */
  pctChange: number | null
  /** MA30（项目指标表无 ma20，统一用 ma30，与个股/指数口径一致） */
  ma30: number | null
  /** DIF */
  dif: number | null
  /** DEA */
  dea: number | null
  /** MACD 柱 */
  macd: number | null
  /** KDJ-K */
  kdjK: number | null
  /** KDJ-D */
  kdjD: number | null
  /** KDJ-J */
  kdjJ: number | null
  /** 是否公布 IOPV */
  publishIopv: boolean | null
  /** 最小申赎单位 */
  creationUnit: number | null
  /** 现金替代比例上限(%) */
  maxCashRatio: number | null
  /** 成分股数 */
  componentCount: number | null
}

export interface EtfLatestResult {
  rows: EtfLatestRow[]
  total: number
}

/** 后端 sort 白名单。列定义 key 必须等于这些值，才能直发后端。 */
export type EtfLatestSortField =
  | 'pct_change'
  | 'close'
  | 'ma30'
  | 'dif'
  | 'dea'
  | 'macd'
  | 'kdj_k'
  | 'kdj_d'
  | 'kdj_j'
  | 'component_count'
  | 'creation_unit'
  | 'max_cash_ratio'
  | 'trade_date'

/** PCF 成分股明细行（GET /api/etf/pcf） */
export interface EtfPcfRow {
  /** 成分股代码 */
  conCode: string
  /** 成分股名称 */
  conName: string
  /** 持股数量（后端返回字符串，因 numeric::text） */
  quantity: number | string
  /** 现金替代标志 */
  substFlag: string
  /** 申购溢价比例(%)（后端字段 premiumRate） */
  premiumRate: number | null
  /** 赎回折价比例(%)（后端字段 discountRate） */
  discountRate: number | null
}
