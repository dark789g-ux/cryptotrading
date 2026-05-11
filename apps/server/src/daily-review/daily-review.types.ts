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

export type ProgressStage =
  | 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize'
  | 'completed' | 'failed';

export type ProgressEvent =
  | { stage: 'validate' | 'fetch' | 'build' | 'reasoning' | 'writing' | 'finalize'; percent: number; message?: string }
  | { stage: 'completed'; percent: 100 }
  | { stage: 'failed'; percent: number; error: string };
