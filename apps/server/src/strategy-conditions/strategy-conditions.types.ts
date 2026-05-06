/** boolean 类型的列，SQL 中需强转为 int 才能与数值比较 */
export const ASHARE_BOOLEAN_COLS = new Set(['i.brick_xg']);

export const ASHARE_FIELD_COL_MAP: Record<string, string> = {
  macd_dif: 'i.dif',
  macd_dea: 'i.dea',
  macd_hist: 'i.macd',
  kdj_j: 'i.kdj_j',
  kdj_k: 'i.kdj_k',
  kdj_d: 'i.kdj_d',
  bbi: 'i.bbi',
  ma5: 'i.ma5',
  ma30: 'i.ma30',
  ma60: 'i.ma60',
  ma120: 'i.ma120',
  ma240: 'i.ma240',
  atr14: 'i.atr_14',
  profit_loss_ratio: 'i.risk_reward_ratio',
  brick: 'i.brick',
  brick_delta: 'i.brick_delta',
  brick_xg: 'i.brick_xg',
  close: 'q.close',
  open: 'q.open',
  high: 'q.high',
  low: 'q.low',
  volume: 'q.vol',
  amount: 'q.amount',
  pct_chg: 'q.pct_chg',
  turnover_rate: 'm.turnover_rate',
  volume_ratio: 'm.volume_ratio',
  pe: 'm.pe',
  pe_ttm: 'm.pe_ttm',
  pb: 'm.pb',
  total_mv: 'm.total_mv',
  circ_mv: 'm.circ_mv',
};

export const CRYPTO_FIELD_COL_MAP: Record<string, string> = {
  macd_dif: 'k.dif',
  macd_dea: 'k.dea',
  macd_hist: 'k.macd',
  kdj_j: 'k.kdj_j',
  kdj_k: 'k.kdj_k',
  kdj_d: 'k.kdj_d',
  bbi: 'k.bbi',
  ma5: 'k.ma5',
  ma30: 'k.ma30',
  ma60: 'k.ma60',
  ma120: 'k.ma120',
  ma240: 'k.ma240',
  atr14: 'k.atr_14',
  profit_loss_ratio: 'k.risk_reward_ratio',
  close: 'k.close',
  open: 'k.open',
  high: 'k.high',
  low: 'k.low',
  volume: 'k.volume',
  amount: 'k.quote_volume',
};

export interface RunResult {
  hits: Array<{
    tsCode: string;
    name: string;
    matchedConditions: string[];
  }>;
  totalHits: number;
  totalScanned: number;
}

export interface RunProgress {
  runId: string;
  status: string;
  progressScanned: number;
  progressTotal: number;
  totalHits: number;
  errorMessage: string | null;
}

export interface LastRunStatus {
  conditionId: string;
  freshness: 'fresh' | 'stale' | 'never' | 'running' | 'failed';
  lastRunAt: string | null;
  totalHits: number;
}
