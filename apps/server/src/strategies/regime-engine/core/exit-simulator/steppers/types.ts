/**
 * exit-simulator/steppers/types.ts
 *
 * 日频出场状态机：各模式持仓状态联合类型。
 */

import { HoldingDaySnapshot, ExitDecision, PhaseLockOptions, BandLockOptions } from '../types';

export interface FixedNPositionState {
  mode: 'fixed_n';
  tradableCount: number;
  lastQuoteDay: HoldingDaySnapshot;
  lastQuoteTradable: number;
}

export interface StrategyPositionState {
  mode: 'strategy';
  tradableCount: number;
  lastQuoteDay: HoldingDaySnapshot;
  lastQuoteTradable: number;
}

export interface BandLockPositionState {
  mode: 'trailing_lock';
  scheme: 1 | 2;
  cost: number;
  stopNext: number | null;
  locked: boolean;
  floorActive: boolean;
  pending: 'stop' | 'ma5_exit' | null;
  hold: number;
  prevMa5: number | null;
  floorPrice: number;
  lastQuoteDay: HoldingDaySnapshot;
  lastQuoteHold: number;
}

export interface PhaseLockPositionState {
  mode: 'phase_lock';
  cost: number;
  stopNext: number | null;
  locked: boolean;
  pending: 'phase_lock_stop' | 'phase_lock_ma5' | null;
  hold: number;
  prevMa5: number | null;
  lastQuoteDay: HoldingDaySnapshot;
  lastQuoteHold: number;
}

export type ExitPositionState =
  | FixedNPositionState
  | StrategyPositionState
  | BandLockPositionState
  | PhaseLockPositionState;

export interface FixedNStepOpts {
  horizonN: number;
  delistDate: string | null;
}

export interface StrategyStepOpts {
  maxHold: number;
  delistDate: string | null;
}

export type BandLockStepOpts = BandLockOptions;

export type PhaseLockStepOpts = PhaseLockOptions;

export interface StepResult<S, D = ExitDecision> {
  state: S;
  decision: D | null;
  /**
   * 本步已终结且无出场（如退市日但 lastQuote 无有效 close）。
   * decide* 遇此应立即返回 null / no_exit，不可继续循环。
   */
  done?: boolean;
}

/** phase_lock 步进退出信息；decidePhaseLock 映射为 PhaseLockOutcome。 */
export interface PhaseLockStepDecision {
  reason: 'phase_lock_stop' | 'phase_lock_ma5' | 'delist';
  exitDay: HoldingDaySnapshot;
  exitPrice: number | null;
  holdDays: number;
  locked: boolean;
}

export type InitPhaseLockResult =
  | { kind: 'ok'; state: PhaseLockPositionState }
  | { kind: 'no_entry'; reason: 'suspended' | 'limit_up' };
