/**
 * 活跃市值（AMV）模块 TS 接口定义。spec §3/§5/§7。
 */

/** 三态信号：多头 +1 / 中性 0 / 空头 -1 */
export type AmvSignal = -1 | 0 | 1

/** 同步模式 */
export type AmvSyncMode = 'incremental' | 'overwrite'

/** calcAmvSeries 入参：量序列（已 ×1000 到元）+ 价序列（个股 qfq / 行业指数点位） */
export interface AmvSeriesInput {
  /** 量：成交额（已换算到元，调用方负责 ×1000） */
  amountInYuan: number[]
  open: number[]
  high: number[]
  low: number[]
  close: number[]
}

/** calcAmvSeries 出参：AMV 四价 + 当日是否异常（v3≤0 或 AMVc≤0） */
export interface AmvSeriesResult {
  amvOpen: number[]
  amvHigh: number[]
  amvLow: number[]
  amvClose: number[]
  /** invalid[t]=true 表示该日不产指标（停牌/脏数据） */
  invalid: boolean[]
}

/** 个股同步入参（spec §7：POST /active-mv/stock/sync） */
export interface StockAmvSyncOptions {
  startDate?: string
  endDate?: string
  syncMode?: AmvSyncMode
  /** 可选：仅同步指定个股代码（不传则全市场） */
  tsCodes?: string[]
}

/**
 * 同花顺指数（行业 type='I' / 概念 type='N'）AMV 同步入参。
 * spec §7：POST /active-mv/{industry,concept}/sync。两类共用同一形态，不新增字段。
 */
export interface ThsIndexAmvSyncOptions {
  startDate?: string
  endDate?: string
  syncMode?: AmvSyncMode
  /** 可选：仅同步指定指数代码（.TI；不传则按 type 取全部 I 或全部 N） */
  tsCodes?: string[]
}

/** 兼容别名（行业语境）：与 ThsIndexAmvSyncOptions 完全同形。 */
export type IndustryAmvSyncOptions = ThsIndexAmvSyncOptions

/**
 * 申万指数（.SI）AMV 同步入参。
 * spec 2026-06-28：POST /active-mv/sw/sync。
 */
export interface SwIndexAmvSyncOptions {
  startDate?: string
  endDate?: string
  syncMode?: AmvSyncMode
  /** 可选：仅同步指定申万指数代码（.SI；不传则 sw_index_catalog 全部） */
  tsCodes?: string[]
}

/** 同步结果 */
export interface AmvSyncResult {
  synced: number
  /** 空数据 / 0 行等异常透出（data-integrity：禁伪装已同步） */
  errors?: string[]
  failedItems?: Array<{ tsCode: string; apiName: string; reason?: string }>
}

/** 单标的 AMV 序列内部计算行（落库前） */
export interface AmvDailyRow {
  tsCode: string
  tradeDate: string
  amvOpen: number
  amvHigh: number
  amvLow: number
  amvClose: number
  amvDif: number
  amvDea: number
  amvMacd: number
  amvZdf: number | null
  signal: AmvSignal
  /** 行业表专用：当日有 amount 的成分股数；个股表忽略 */
  memberCount?: number
}

/** GET /active-mv/{stock,industry}/:tsCode 返回的单行（前端 K 线副图用） */
export interface AmvSeriesRow {
  tradeDate: string
  amvOpen: number
  amvHigh: number
  amvLow: number
  amvClose: number
  amvDif: number
  amvDea: number
  amvMacd: number
  amvZdf: number | null
  signal: AmvSignal
  memberCount?: number
}

/** GET /active-mv/{stock,industry}/signals?tradeDate= 返回的单行 */
export interface AmvSignalRow {
  tsCode: string
  tradeDate: string
  amvDif: number
  amvMacd: number
  signal: AmvSignal
  memberCount?: number
}
