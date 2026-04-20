import type { CandleLogEntry, TradeRecord } from '../models';

export interface BacktestResult {
  trades: TradeRecord[];
  portfolioLog: [string, number][];
  posSnapshots: Array<Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }>>;
  /** 逐根 K 线事件日志 */
  candleLog: CandleLogEntry[];
}
