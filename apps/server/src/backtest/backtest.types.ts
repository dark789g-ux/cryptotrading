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
  /** 仅保留本根 entries/exits 中出现过的标的 */
  only_action_on_bar?: boolean;
  /** 仅保留本根收盘仍持仓的标的（依赖 open_symbols_json，旧 run 需重跑回测） */
  only_open_at_close?: boolean;
}

export interface RunSymbolMetricRow {
  symbol: string;
  dataStatus: 'ok' | 'missing';
  close: number | null;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  kdjJ: number | null;
  riskRewardRatio: number | null;
  stopLossPct: number | null;
}
