export type IndexQuote = { tsCode: string; name: string; close: number; pctChg: number; amount: number };
export type LimitStats = { upCount: number; downCount: number; brokenCount: number };
export type UpdownDist = { up: number; down: number; flat: number; limitUp: number; limitDown: number };
export type SectorRow  = { name: string; pctChg: number };
export type StockRow   = { tsCode: string; name: string; netIn?: number; pctChg?: number; turnoverRate?: number; amount?: number };

// ===== Snapshot 扩展字段（spec §4.3）=====
export interface OvernightPayload {
  usIndices: { name: string; close: number; pctChg: number; quotedAt: string }[];
  chipStocks: { ticker: string; pctChg: number; note?: string }[];
  chinaConcepts: { ticker: string; pctChg: number }[];
  commodities: { name: string; price: number; unit: string; quotedAt: string }[];
}

export interface MacroCalendarPayload {
  todayEvents: { time: string; event: string; importance: 'low' | 'mid' | 'high' }[];
  upcomingEvents: { date: string; event: string }[];
}

export interface PreviousReviewSummary {
  tradeDate: string;
  nextDayJudgmentExcerpt: string;
}

export interface SnapshotPayload {
  indices: IndexQuote[];
  limitStats: LimitStats;
  updownDist: UpdownDist;
  industryRank: SectorRow[];
  conceptRank: SectorRow[];
  moneyFlow: {
    market: { netIn: number };
    stocksTopIn: StockRow[];
    stocksTopOut: StockRow[];
  };
  strongStocks: StockRow[];
  volumeTop: StockRow[];
  generatedAt: string;
  // 三块新增字段，缺失时为 null
  overnight: OvernightPayload | null;
  macroCalendar: MacroCalendarPayload | null;
  previousReviewSummary: PreviousReviewSummary | null;
}

// 业务阶段：完成态与失败态独立为事件类型，不再混入 stage 字段（与 spec §5 一致）
// 新增 'investigate' 阶段：Stage1 Investigator LLM tool-calling 循环
export type Stage = 'validate' | 'fetch' | 'build' | 'investigate' | 'reasoning' | 'writing' | 'finalize';

export interface TokenUsage {
  prompt: number;
  completion: number;
  reasoning: number;
  total: number;
}

// 用于落库的阶段耗时记录；startedAt 为 UTC 墙钟字符串（CLAUDE.md 时间规范）
export interface StageTiming {
  stage: Stage;
  startedAt: string;
  durationMs: number;
}

export type ProgressEvent =
  | { type: 'stage';           stage: Stage; percent: number; ts: number; message?: string }
  | { type: 'reasoning_delta'; text: string; ts: number }
  | { type: 'content_delta';   text: string; ts: number }
  | { type: 'usage';           tokens: TokenUsage; ts: number }
  | { type: 'stage_done';      stage: Stage; durationMs: number; ts: number }
  | { type: 'tool_call';       callIndex: number; name: string; args: Record<string, unknown>; durationMs: number; startedAt: string; error?: string; ts: number }
  | { type: 'completed';       ts: number }
  | { type: 'failed';          error: string; ts: number };

// ====== Tool-calling (spec §4.4 / §5.3) ======
export interface ToolCallLog {
  callIndex: number;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  /** UTC 墙钟字符串（ISO8601），CLAUDE.md 时间规范 */
  startedAt: string;
  error?: string;
}

export type EvidenceFact =
  | { type: 'news'; source: string; summary: string; url: string; publishedAt: string }
  | { type: 'moneyflow'; summary: string }
  | { type: 'concept_constituent'; summary: string; tsCodes: string[] }
  | { type: 'top_list'; summary: string; tsCode: string };

export interface EvidencePack {
  hypotheses: Array<{
    claim: string;
    supportingFacts: EvidenceFact[];
    relevantSectors: string[];
    relevantStocks: string[];
  }>;
  yesterdayVerification?: {
    yesterdayJudgment: string;
    todayValidated: boolean;
    deviationNote: string;
  } | null;
  /** 当 LLM 最终消息不是合法 JSON 时的兜底原文 */
  rawText?: string;
}
