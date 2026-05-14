// 5 个 tool handler 的公共类型 + handler 接口
// 对应 doc/specs/2026-05-13-tool-calling-daily-review-design.md § 5.1
//
// 设计要点（CLAUDE.md / spec § 4.4）：
// - handler 只负责"业务逻辑 + 数据装配"，不计时、不捕获异常
//   （计时、超时、try/catch 全部由 ToolDispatcherService 收口）
// - handler 入参由 LLM 生成，类型不可信；handler 内做最小校验，缺关键参数
//   抛 ToolArgError（含可读 message），由 dispatcher 包成 { error } 回给 LLM
// - DB 查询结果中的 ts_code / pct_chg 等都按"字符串可能性"安全转 number

import type { NewsHit } from '../news/news.types';

/** 工具入参校验失败时抛出的轻量错误；dispatcher 会捕获并转 error 字段 */
export class ToolArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ToolArgError';
  }
}

/** Handler 公共接口；call 入参/出参都用 unknown 让 dispatcher 收口序列化 */
export interface ToolHandler {
  readonly name: string;
  call(args: Record<string, unknown>): Promise<unknown>;
}

// ===== search_news =====
export interface SearchNewsResult {
  hits: NewsHit[];
  degraded: boolean;
  source: 'tavily' | 'serper' | 'none';
}

// ===== lookup_stock =====
export interface StockBasic {
  name: string;
  industry: string | null;
  area: string | null;
  listDate: string | null;
  marketCap: number | null;
}

export interface StockRecentFlow {
  /** 近 5 个交易日（按 trade_date DESC）主力净流入合计，单位元 */
  last5dNetIn: number | null;
  /** 近 20 个交易日 主力净流入合计，单位元 */
  last20dNetIn: number | null;
  /** 最近一次（最大 trade_date）的资金流相对当日净流入排名（从 1 起）；null 表示当日无数据 */
  todayRank: number | null;
}

/** lookup_stock 嵌入的 top_list 条目（近 5 个交易日上榜） */
export interface StockTopListEntry {
  tradeDate: string;
  netAmount: number | null;
  reason: string | null;
}

export interface LookupStockResult {
  basic: StockBasic;
  recentFlow: StockRecentFlow;
  concepts: string[];
  topListEntries: StockTopListEntry[];
}

// ===== lookup_concept =====
export interface ConceptConstituent {
  tsCode: string;
  name: string | null;
  pctChg: number | null;
  mainNetIn: number | null;
  /** 该板块当日 mainNetIn 排名第 1 视为龙头 */
  isLeader: boolean;
}

export interface LookupConceptResult {
  matchedName: string;
  todayPctChg: number | null;
  constituents: ConceptConstituent[];
}

// ===== fetch_top_list =====
export interface TopListEntry {
  tradeDate: string;
  tsCode: string;
  name: string | null;
  close: number | null;
  pctChange: number | null;
  turnoverRate: number | null;
  amount: number | null;
  lBuy: number | null;
  lSell: number | null;
  lAmount: number | null;
  netAmount: number | null;
  netRate: number | null;
  amountRate: number | null;
  floatValues: number | null;
  reason: string | null;
}

export type FetchTopListResult =
  | { mode: 'daily'; tradeDate: string; entries: TopListEntry[] }
  | { mode: 'recent5d'; tsCode: string; entries: TopListEntry[]; appearCount: number };
