export type IndexQuote = { tsCode: string; name: string; close: number; pctChg: number; amount: number };
export type LimitStats = { upCount: number; downCount: number; brokenCount: number };
export type UpdownDist = { up: number; down: number; flat: number; limitUp: number; limitDown: number };
export type SectorRow  = { name: string; pctChg: number };
export type StockRow   = { tsCode: string; name: string; mainNetIn?: number; pctChg?: number; turnoverRate?: number; amount?: number };

export interface SnapshotPayload {
  indices: IndexQuote[];
  limitStats: LimitStats;
  updownDist: UpdownDist;
  industryRank: SectorRow[];
  conceptRank: SectorRow[];
  moneyFlow: {
    market: { mainNetIn: number };
    stocksTopIn: StockRow[];
    stocksTopOut: StockRow[];
  };
  strongStocks: StockRow[];
  volumeTop: StockRow[];
  generatedAt: string;
}

// 业务阶段：完成态与失败态独立为事件类型，不再混入 stage 字段（与 spec §5 一致）
export type Stage = 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize';

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
  | { type: 'completed';       ts: number }
  | { type: 'failed';          error: string; ts: number };
