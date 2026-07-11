/**
 * exit-simulator/core.ts
 *
 * 逐笔出场模拟核心：simulateTradeCore。
 * 现为入场过滤 + 日频 stepper 批处理循环的 oracle（单测 / 对拍用）。
 * 组合引擎主路径已改为持仓内日推进，不再在开仓时调用本函数。
 *
 * TODO(P2b): enablePartialProfit + partialProfitRatio — 日线 recentHigh 触发部分减仓后余仓续持。
 */

import {
  SimulationInput,
  SimulationOutcome,
  ExitDecision,
  NEW_LISTING_MIN_TRADING_DAYS,
} from './types';
import { decideFixedN } from './fixed-n';
import { decideStrategy } from './strategy';
import { decideBandLock } from './band-lock';
import { decidePhaseLock } from './phase-lock';

/**
 * 对一个买入信号做逐笔出场模拟（纯函数）。
 *
 * 流程：入场过滤 → 入场取价 → 出场推进 → 算 ret/holdDays。
 * 任一过滤命中 → { kind:'filtered', reason }；成功 → { kind:'trade', trade }。
 *
 * @param input 信号 + 持有窗口数据序列（buy_date 起升序）
 */
export function simulateTradeCore(input: SimulationInput): SimulationOutcome {
  const { tsCode, signalDate, days, daysSinceList, delistDate, exit } = input;

  if (days.length === 0) {
    return { kind: 'filtered', reason: 'insufficient_data' };
  }
  const buyDay = days[0];
  const buyDate = buyDay.calDate;

  if (!buyDay.hasQuote || buyDay.qfqOpen === null) {
    return { kind: 'filtered', reason: 'suspended' };
  }
  if (
    buyDay.rawOpen !== null &&
    buyDay.upLimit !== null &&
    buyDay.rawOpen >= buyDay.upLimit
  ) {
    return { kind: 'filtered', reason: 'limit_up' };
  }
  if (
    !input.skipNewListingFilter &&
    daysSinceList !== null &&
    daysSinceList < NEW_LISTING_MIN_TRADING_DAYS
  ) {
    return { kind: 'filtered', reason: 'new_listing' };
  }

  const buyPrice = buyDay.qfqOpen;

  let decision: ExitDecision | null;
  if (exit.mode === 'fixed_n') {
    decision = decideFixedN(days, exit.horizonN, delistDate);
  } else if (exit.mode === 'strategy') {
    decision = decideStrategy(days, exit.maxHold, delistDate);
  } else if (exit.mode === 'trailing_lock') {
    if (input.signalHigh === undefined) {
      return { kind: 'filtered', reason: 'insufficient_data' };
    }
    decision = decideBandLock(days, {
      signalHigh: input.signalHigh,
      maxHold: exit.maxHold,
      delistDate,
      stopRatio: exit.stopRatio,
      floorRatio: exit.floorRatio,
      floorEnabled: exit.floorEnabled,
      ma5RequireDown: exit.ma5RequireDown,
    });
  } else {
    const outcome = decidePhaseLock(days, input.recentLows ?? [], {
      initFactor: exit.initFactor,
      lockFactor: exit.lockFactor,
      lookback: exit.lookback,
      delistDate,
    });
    if (outcome.kind === 'no_entry') {
      return { kind: 'filtered', reason: outcome.reason === 'limit_up' ? 'limit_up' : 'suspended' };
    }
    if (outcome.kind === 'no_exit') {
      decision = null;
    } else {
      decision = {
        exitDay: days[outcome.exitIndex!],
        exitReason: outcome.reason as ExitDecision['exitReason'],
        exitPrice: outcome.exitPrice ?? undefined,
        holdDays: outcome.holdDays,
      };
    }
  }

  if (decision === null) {
    return { kind: 'filtered', reason: 'insufficient_data' };
  }

  const { exitDay, exitReason, holdDays } = decision;
  const exitPrice = decision.exitPrice ?? exitDay.qfqClose;
  if (exitPrice === null) {
    return { kind: 'filtered', reason: 'insufficient_data' };
  }

  const ret = exitPrice / buyPrice - 1;

  return {
    kind: 'trade',
    trade: {
      tsCode,
      signalDate,
      buyDate,
      exitDate: exitDay.calDate,
      buyPrice,
      exitPrice,
      ret,
      holdDays,
      exitReason,
    },
  };
}
