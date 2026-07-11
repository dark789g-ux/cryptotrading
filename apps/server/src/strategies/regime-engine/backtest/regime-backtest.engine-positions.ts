/**
 * regime-backtest.engine-positions.ts
 *
 * 日频出场：入场过滤 + init exit state + step 推进。
 * 从 runRegimeBacktest 拆出，保持引擎主循环可读。
 */

import {
  HoldingDaySnapshot,
  ExitConfig,
  SimulationInput,
  NEW_LISTING_MIN_TRADING_DAYS,
  initFixedNState,
  stepFixedN,
  initStrategyState,
  stepStrategy,
  initBandLockState,
  stepBandLock,
  initPhaseLockState,
  stepPhaseLock,
  ExitPositionState,
} from '../core/exit-simulator';
import { SkipReason } from '../core/types';
import {
  RegimeBacktestInput,
  RegimeBacktestTrade,
  RegimeKellyConfig,
} from './regime-backtest.types';
import { computeSourceKellyMult } from '../core/sizing';

export interface OpenPosition {
  tsCode: string;
  buyDate: string;
  exitDate?: string;
  ret?: number;
  alloc: number;
  buyCost: number;
  entryPrice: number;
  mv: number;
  lastMarkPrice: number;
  daysByDate: Map<string, HoldingDaySnapshot>;
  exitState: ExitPositionState;
  exit: ExitConfig;
  signalHigh?: number;
  recentLows?: number[];
  delistDate: string | null;
  trade: RegimeBacktestTrade;
}

export type InitExitResult =
  | { ok: true; state: ExitPositionState; entryPrice: number; buyDate: string }
  | { ok: false; reason: SkipReason };

/** 入场过滤 + 初始化出场状态（不预算出场日）。 */
export function tryInitExitFromSignal(simInput: SimulationInput): InitExitResult {
  const { days, exit, daysSinceList } = simInput;

  if (days.length === 0) {
    return { ok: false, reason: 'insufficient_data' };
  }
  const buyDay = days[0];
  const buyDate = buyDay.calDate;

  if (!buyDay.hasQuote || buyDay.qfqOpen === null) {
    return { ok: false, reason: 'suspended' };
  }
  if (
    buyDay.rawOpen !== null &&
    buyDay.upLimit !== null &&
    buyDay.rawOpen >= buyDay.upLimit
  ) {
    return { ok: false, reason: 'limit_up' };
  }
  if (
    !simInput.skipNewListingFilter &&
    daysSinceList !== null &&
    daysSinceList < NEW_LISTING_MIN_TRADING_DAYS
  ) {
    return { ok: false, reason: 'new_listing' };
  }

  const entryPrice = buyDay.qfqOpen;

  if (exit.mode === 'fixed_n') {
    return { ok: true, state: initFixedNState(buyDay), entryPrice, buyDate };
  }
  if (exit.mode === 'strategy') {
    return { ok: true, state: initStrategyState(buyDay), entryPrice, buyDate };
  }
  if (exit.mode === 'trailing_lock') {
    if (simInput.signalHigh === undefined) {
      return { ok: false, reason: 'insufficient_data' };
    }
    return {
      ok: true,
      state: initBandLockState(buyDay, {
        stopRatio: exit.stopRatio,
        floorRatio: exit.floorRatio,
      }),
      entryPrice,
      buyDate,
    };
  }

  const phaseInit = initPhaseLockState(buyDay, simInput.recentLows ?? [], {
    initFactor: exit.initFactor,
  });
  if (phaseInit.kind === 'no_entry') {
    return { ok: false, reason: phaseInit.reason };
  }
  return { ok: true, state: phaseInit.state, entryPrice, buyDate };
}

interface AppliedExit {
  exitDate: string;
  ret: number;
  exitReason: string;
}

/**
 * 对单日推进出场状态。
 * - d < buyDate：跳过
 * - d === buyDate：不 step（T+1）
 * - d > buyDate：取 bar step；无 bar 则跳过
 * - 有 decision → 返回出场信息
 * - done 无 decision（退市日但 lastQuote 无有效 close）→ 用 lastMarkPrice 以 delist 强平，避免僵尸仓
 */
export function stepOpenPosition(pos: OpenPosition, d: string): AppliedExit | null {
  if (d < pos.buyDate) return null;
  if (d === pos.buyDate) return null;

  const bar = pos.daysByDate.get(d);
  if (!bar) return null;

  const exit = pos.exit;
  let exitDate: string | null = null;
  let exitReason: string | null = null;
  let exitPrice: number | null = null;

  const applyDoneWithoutDecision = (): AppliedExit => {
    const price = pos.lastMarkPrice;
    const ret = pos.entryPrice > 0 ? price / pos.entryPrice - 1 : 0;
    return { exitDate: d, ret, exitReason: 'delist' };
  };

  if (exit.mode === 'fixed_n' && pos.exitState.mode === 'fixed_n') {
    const result = stepFixedN(pos.exitState, bar, {
      horizonN: exit.horizonN,
      delistDate: pos.delistDate,
    });
    pos.exitState = result.state;
    if (result.done && !result.decision) return applyDoneWithoutDecision();
    if (result.decision) {
      exitDate = result.decision.exitDay.calDate;
      exitReason = result.decision.exitReason;
      exitPrice = result.decision.exitPrice ?? result.decision.exitDay.qfqClose;
    }
  } else if (exit.mode === 'strategy' && pos.exitState.mode === 'strategy') {
    const result = stepStrategy(pos.exitState, bar, {
      maxHold: exit.maxHold,
      delistDate: pos.delistDate,
    });
    pos.exitState = result.state;
    if (result.done && !result.decision) return applyDoneWithoutDecision();
    if (result.decision) {
      exitDate = result.decision.exitDay.calDate;
      exitReason = result.decision.exitReason;
      exitPrice = result.decision.exitPrice ?? result.decision.exitDay.qfqClose;
    }
  } else if (exit.mode === 'trailing_lock' && pos.exitState.mode === 'trailing_lock') {
    if (pos.signalHigh === undefined) return null;
    const result = stepBandLock(pos.exitState, bar, {
      signalHigh: pos.signalHigh,
      maxHold: exit.maxHold,
      delistDate: pos.delistDate,
      stopRatio: exit.stopRatio,
      floorRatio: exit.floorRatio,
      floorEnabled: exit.floorEnabled,
      ma5RequireDown: exit.ma5RequireDown,
    });
    pos.exitState = result.state;
    if (result.done && !result.decision) return applyDoneWithoutDecision();
    if (result.decision) {
      exitDate = result.decision.exitDay.calDate;
      exitReason = result.decision.exitReason;
      exitPrice = result.decision.exitPrice ?? result.decision.exitDay.qfqClose;
    }
  } else if (exit.mode === 'phase_lock' && pos.exitState.mode === 'phase_lock') {
    const result = stepPhaseLock(pos.exitState, bar, {
      initFactor: exit.initFactor,
      lockFactor: exit.lockFactor,
      lookback: exit.lookback,
      delistDate: pos.delistDate,
    });
    pos.exitState = result.state;
    if (result.done && !result.decision) return applyDoneWithoutDecision();
    if (result.decision) {
      exitDate = result.decision.exitDay.calDate;
      exitReason = result.decision.reason;
      exitPrice = result.decision.exitPrice ?? result.decision.exitDay.qfqClose;
    }
  }

  if (exitDate === null || exitReason === null || exitPrice === null) {
    return null;
  }

  const ret = pos.entryPrice > 0 ? exitPrice / pos.entryPrice - 1 : 0;
  return { exitDate, ret, exitReason };
}

export function applyExitToPosition(pos: OpenPosition, applied: AppliedExit): void {
  pos.exitDate = applied.exitDate;
  pos.ret = applied.ret;
  pos.trade.exitDate = applied.exitDate;
  pos.trade.ret = applied.ret;
  pos.trade.exitReason = applied.exitReason;
}

export function forceClosePositionAtPrice(
  pos: OpenPosition,
  d: string,
  reason: string,
): void {
  const bar = pos.daysByDate.get(d);
  const closePrice = bar?.qfqClose ?? pos.lastMarkPrice;
  const ret = pos.entryPrice > 0 ? closePrice / pos.entryPrice - 1 : 0;
  pos.ret = ret;
  pos.exitDate = d;
  pos.trade.exitDate = d;
  pos.trade.ret = ret;
  pos.trade.exitReason = reason;
}

export function markPosition(pos: OpenPosition, d: string): void {
  const bar = pos.daysByDate.get(d);
  if (!bar) return;
  if (!bar.hasQuote || bar.qfqClose === null) return;
  if (Number.isFinite(pos.lastMarkPrice) && pos.lastMarkPrice !== 0) {
    pos.mv *= bar.qfqClose / pos.lastMarkPrice;
  }
  pos.lastMarkPrice = bar.qfqClose;
}

export function forceClosePositions(
  list: OpenPosition[],
  d: string,
  reason: string,
  onClose: (pos: OpenPosition) => void,
): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const pos = list[i];
    forceClosePositionAtPrice(pos, d, reason);
    onClose(pos);
    list.splice(i, 1);
  }
}

export function stepAndClosePositions(
  list: OpenPosition[],
  d: string,
  onClose: (pos: OpenPosition) => void,
): void {
  for (let i = list.length - 1; i >= 0; i--) {
    const pos = list[i];
    const applied = stepOpenPosition(pos, d);
    if (!applied) continue;
    applyExitToPosition(pos, applied);
    onClose(pos);
    list.splice(i, 1);
  }
}

export function isKellyPipelineEnabled(input: RegimeBacktestInput): boolean {
  const { sizing, kelly } = input.capital;
  return sizing?.mode === 'source_kelly' && kelly?.enabled === true;
}

export function collectCompletedRets(trades: RegimeBacktestTrade[]): number[] {
  return trades
    .filter((t) => t.status === 'taken' && t.ret !== undefined)
    .map((t) => t.ret!);
}

export function computeKellyMult(
  kelly: RegimeKellyConfig,
  completedRets: number[],
): number {
  const window = completedRets.slice(-kelly.windowTrades);
  return computeSourceKellyMult(window, {
    kellyFraction: kelly.kellyFraction,
    kellyMaxMult: kelly.kellyMaxMult,
  });
}
