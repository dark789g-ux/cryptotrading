export interface BacktestProgress {
  status: 'running' | 'done' | 'error';
  phase: string;
  percent: number;
  currentTs: string | null;
  startTs: string | null;
  endTs: string | null;
  startedAt: number;
  elapsedMs: number;
  etaMs: number | null;
  message?: string;
  runId?: string;
}

export const PROGRESS_RETENTION_MS = 30_000;

export type StatsRow = Record<string, unknown>;

export interface PositionQueryOptions {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder: 'ASC' | 'DESC';
  symbol?: string;
  pnlMin?: number;
  pnlMax?: number;
  returnPctMin?: number;
  returnPctMax?: number;
  stopType?: string;
  entryStart?: string;
  entryEnd?: string;
  closeStart?: string;
  closeEnd?: string;
}

export interface SymbolQueryOptions {
  page: number;
  pageSize: number;
  sortBy?: string;
  sortOrder: 'ASC' | 'DESC';
  symbol?: string;
  totalPnlMin?: number;
  totalPnlMax?: number;
  winRateMin?: number;
  winRateMax?: number;
}

export interface RunSymbolMetricsQueryDto {
  ts: string;
  q?: string;
  conditions?: { field: string; op: string; value: number }[];
  sort: { field: string; asc: boolean };
  page: number;
  page_size: number;
  /** 仅保留本根买入语义标的（entries 或相对上一根新增收盘持仓） */
  only_buy_on_bar?: boolean;
  /** 仅保留本根卖出语义标的（exits 或相对上一根减少收盘持仓） */
  only_sell_on_bar?: boolean;
  /**
   * 仅保留本根收盘仍持仓的标的（依赖 open_symbols_json，旧 run 需重跑回测）。
   * 与 only_buy_on_bar / only_sell_on_bar 多选时为所选条件的并集（OR）。
   */
  only_open_at_close?: boolean;
}

export interface RunSymbolMetricRow {
  symbol: string;
  dataStatus: 'ok' | 'missing';
  /** entries 或本根相对上一根新增收盘持仓 */
  buyOnBar: boolean;
  /** exits 或本根相对上一根减少收盘持仓 */
  sellOnBar: boolean;
  /** 本根 K 线收盘时仍持仓 */
  holdAtClose: boolean;
  close: number | null;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  kdjJ: number | null;
  riskRewardRatio: number | null;
  stopLossPct: number | null;
}
