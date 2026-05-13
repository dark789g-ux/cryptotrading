// EvidencePack / ToolCallLog 类型定义
// 对应 doc/specs/2026-05-13-tool-calling-daily-review-design.md § 4.4
// 由 Stage1 Investigator 产出，落库到 daily_review.evidence_pack / investigator_tool_calls

export type NewsFact = {
  type: 'news';
  source: string;
  summary: string;
  url: string;
  publishedAt: string; // ISO8601 字符串
};

export type MoneyFlowFact = {
  type: 'moneyflow';
  summary: string;
};

export type ConceptConstituentFact = {
  type: 'concept_constituent';
  summary: string;
  tsCodes: string[];
};

export type TopListFact = {
  type: 'top_list';
  summary: string;
  tsCode: string;
};

export type SupportingFact =
  | NewsFact
  | MoneyFlowFact
  | ConceptConstituentFact
  | TopListFact;

export interface Hypothesis {
  // 单条假设的核心论断，spec 要求 ≤ 80 字
  claim: string;
  // 至少 1 条 supportingFact 才能保留
  supportingFacts: SupportingFact[];
  // 相关板块名（中文）
  relevantSectors: string[];
  // 相关个股，统一用 ts_code（如 "601138.SH"）
  relevantStocks: string[];
}

export interface YesterdayVerification {
  yesterdayJudgment: string;
  todayValidated: boolean;
  deviationNote: string;
}

export interface EvidencePack {
  hypotheses: Hypothesis[];
  // 当存在上一交易日复盘并被验证时填充；否则为 null
  yesterdayVerification: YesterdayVerification | null;
  // LLM 输出 JSON 解析失败时的兜底：保留原始文本
  rawText?: string;
}

// Stage1 单次工具调用日志条目
export interface ToolCallLog {
  callIndex: number;
  name: string;
  args: Record<string, unknown>;
  result: unknown;
  durationMs: number;
  // UTC 墙钟字符串（遵循 CLAUDE.md 时间规范）
  startedAt: string;
  error?: string;
}
