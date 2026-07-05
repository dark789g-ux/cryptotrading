/**
 * exit-simulator/types.ts
 *
 * 出场模拟器所有类型 / 接口 / 常量。
 * 从 signal-stats.simulator.ts 迁移，逻辑不变。
 */

export interface SimulatedTrade {
  tsCode: string;
  signalDate: string;
  buyDate: string;
  exitDate: string;
  buyPrice: number;
  exitPrice: number;
  ret: number;
  holdDays: number;
  exitReason:
    | 'max_hold'
    | 'signal'
    | 'delist'
    | 'stop'
    | 'ma5_exit'
    | 'phase_lock_stop'
    | 'phase_lock_ma5';
}

export type FilterReason =
  | 'suspended'
  | 'limit_up'
  | 'new_listing'
  | 'insufficient_data';

export type SimulationOutcome =
  | { kind: 'trade'; trade: SimulatedTrade }
  | { kind: 'filtered'; reason: FilterReason };

export interface HoldingDaySnapshot {
  calDate: string;
  hasQuote: boolean;
  qfqOpen: number | null;
  qfqClose: number | null;
  qfqHigh: number | null;
  qfqLow: number | null;
  rawOpen: number | null;
  rawHigh: number | null;
  upLimit: number | null;
  downLimit: number | null;
  ma5: number | null;
  exitSignalHit: boolean;
}

export interface SimulationInput {
  tsCode: string;
  signalDate: string;
  days: HoldingDaySnapshot[];
  daysSinceList: number | null;
  delistDate: string | null;
  signalHigh?: number;
  recentLows?: number[];
  skipNewListingFilter?: boolean;
  exit: ExitConfig;
}

export type ExitConfig =
  | { mode: 'fixed_n'; horizonN: number }
  | { mode: 'strategy'; maxHold: number; exitConditions?: unknown[] }
  | {
      mode: 'trailing_lock';
      maxHold?: number;
      stopRatio?: number;
      floorRatio?: number;
      floorEnabled?: boolean;
      ma5RequireDown?: boolean;
    }
  | {
      mode: 'phase_lock';
      initFactor: number;
      lockFactor: number;
      lookback: number;
    };

export interface ExitDecision {
  exitDay: HoldingDaySnapshot;
  exitReason: 'max_hold' | 'signal' | 'delist' | 'stop' | 'ma5_exit';
  exitPrice?: number;
  holdDays: number;
}

export interface BandLockOptions {
  signalHigh: number;
  maxHold?: number;
  delistDate: string | null;
  stopRatio?: number;
  floorRatio?: number;
  floorEnabled?: boolean;
  ma5RequireDown?: boolean;
}

export interface PhaseLockOptions {
  initFactor: number;
  lockFactor: number;
  lookback: number;
  delistDate: string | null;
}

export interface PhaseLockOutcome {
  kind: 'no_entry' | 'exit' | 'no_exit';
  reason: 'suspended' | 'limit_up' | 'phase_lock_stop' | 'phase_lock_ma5' | 'delist' | null;
  exitIndex: number | null;
  exitPrice: number | null;
  holdDays: number;
  locked: boolean;
}

export interface WindowQuote {
  qfqOpen: number | null;
  qfqClose: number | null;
  open: number | null;
  qfqHigh?: number | null;
  qfqLow?: number | null;
  high?: number | null;
  ma5?: number | null;
}

export interface HoldingDayExtras {
  downLimitMap?: Map<string, number | null>;
}

export const NEW_LISTING_MIN_TRADING_DAYS = 60;
