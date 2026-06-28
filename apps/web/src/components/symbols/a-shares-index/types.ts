/**
 * A 股指数行情表 / 目录的前端行类型。
 *
 * 与后端逐字段对齐（camelCase）：
 *  - apps/server/src/market-data/index-daily/index-daily.types.ts （IndexLatestRow / IndexLatestResult）
 *  - apps/server/src/market-data/index-catalog/index-catalog-query.service.ts （IndexCatalogRow）
 *
 * 设计 spec: docs/superpowers/specs/2026-06-22-a-shares-index-tab-design.md
 */

export type IndexCategory = 'market' | 'industry' | 'concept' | 'sw' | 'custom'

/**
 * GET /api/indices/latest 单行（每个指数取最新一日）。
 *
 * 单位（与后端一致，勿混淆）：
 *  - vol：成交量「手」（落库存原样，不转「股」，与 K 线 volume 解耦）
 *  - amount：成交额「千元」，仅大盘（category=market）有
 *  - totalMvWan：总市值「万元」（字符串），仅行业/概念有
 */
export interface IndexLatestRow {
  /** 自定义指数 UUID（category=custom 时用于 K 线/编辑 API） */
  id?: string
  tsCode: string
  name: string
  category: IndexCategory
  /** 最新交易日 YYYYMMDD */
  tradeDate: string
  close: number
  pctChange: number | null
  /** 成交量（手） */
  vol: number | null
  /** 成交额（千元），仅大盘有 */
  amount: number | null
  /** 总市值（万元，字符串），仅行业/概念有 */
  totalMvWan: string | null
  /** 市盈率，仅申万（category='sw'）有 */
  pe: number | null
  /** 市净率，仅申万（category='sw'）有 */
  pb: number | null
  /** 成分股数量；大盘宽基无此信息时为 null */
  count: number | null
  /** 净流入（万元） */
  netAmount: number | null
  /** 净流入（万元，5日累计） */
  netAmount5d: number | null
  /** 净流入（万元，10日累计） */
  netAmount10d: number | null
  /** 净流入（万元，20日累计） */
  netAmount20d: number | null
  /** 大单净流入（万元） */
  buyLgAmount: number | null
  /** 中单净流入（万元） */
  buyMdAmount: number | null
  /** 小单净流入（万元） */
  buySmAmount: number | null
}

export interface IndexLatestResult {
  rows: IndexLatestRow[]
  total: number
}

/**
 * 后端 sort 白名单（apps/server/.../index-daily/dto/latest.dto.ts IndexLatestSortField）。
 * 列定义里这几列的 key 必须等于对应值，n-data-table 表头排序才能直发后端。
 */
export type IndexLatestSortField =
  | 'pct_change'
  | 'vol'
  | 'amount'
  | 'total_mv_wan'
  | 'tradeDate'
  | 'pe'
  | 'pb'
  | 'count'
  | 'net_amount'
  | 'net_amount_5d'
  | 'net_amount_10d'
  | 'net_amount_20d'
  | 'buy_lg_amount'
  | 'buy_md_amount'
  | 'buy_sm_amount'

/** GET /api/index-catalog?category=&q= 单行。 */
export interface IndexCatalogRow {
  tsCode: string
  name: string
  category: IndexCategory
  /** 成分股数量；大盘常量无此信息 */
  count?: number | null
}
