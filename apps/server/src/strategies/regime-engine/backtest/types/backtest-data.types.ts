import { RegimeConfigEntry } from '../../../../entities/strategy/regime-strategy-config.entity';

export interface RawSignal {
  signalDate: string;
  buyDate: string;
  tsCode: string;
  regime: string;
  entry: RegimeConfigEntry;
}

/** 同日全量候选（含 Top1），供 runner 审计落库 */
export interface RankedCandidate {
  signalDate: string;
  buyDate: string;
  tsCode: string;
  regime: string;
  exitMode: string;
  rank: number;
  rankField: string;
  rankValue: number | null;
}

export interface OamvRow {
  trade_date: string;
  open: number | string | null;
  high: number | string | null;
  low: number | string | null;
  close: number | string | null;
  amv_dif: number | null;
  amv_dea: number | null;
  amv_macd: number | null;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  ma120: number | null;
  ma240: number | null;
  kdj_k: number | null;
  kdj_d: number | null;
  kdj_j: number | null;
}

export interface IdxQuoteRow {
  trade_date: string;
  open: number | string | null;
  high: number | string | null;
  low: number | string | null;
  close: number | string | null;
  pre_close: number | string | null;
  change: number | string | null;
  pct_change: number | string | null;
  vol_hand: number | string | null;
  amount: number | string | null;
}

export interface IdxIndicatorRow {
  trade_date: string;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  ma120: number | null;
  ma240: number | null;
  dif: number | null;
  dea: number | null;
  macd: number | null;
  kdj_k: number | null;
  kdj_d: number | null;
  kdj_j: number | null;
  bbi: number | null;
  brick: number | null;
  brick_delta: number | null;
  brick_xg: boolean | null;
}

export interface SymbolMeta {
  listDate: string | null;
  delistDate: string | null;
}
