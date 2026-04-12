/**
 * 连续亏损追踪器 — 精确翻译自 backtest/loss_tracker.py
 */

import { TradeRecord } from './models';

export class LossTracker {
  consecutiveLosses = 0;
  globalCooldownEndIdx = -1;
  currentCooldownCandles: number;

  constructor(
    private readonly baseCooldownCandles: number,
    private readonly maxCooldownCandles: number,
    private readonly consecutiveLossesThreshold: number,
    private readonly consecutiveLossesReduceOnProfit: number,
  ) {
    this.currentCooldownCandles = baseCooldownCandles;
  }

  processTrade(trade: TradeRecord, tsIdx: number): void {
    if (trade.isHalf) return;

    if (trade.pnl < 0) {
      this.consecutiveLosses += 1;
      if (this.consecutiveLosses >= this.consecutiveLossesThreshold) {
        this.currentCooldownCandles = Math.min(
          this.baseCooldownCandles + (this.consecutiveLosses - this.consecutiveLossesThreshold),
          this.maxCooldownCandles,
        );
        this.globalCooldownEndIdx = tsIdx + this.currentCooldownCandles;
      }
    } else {
      if (this.consecutiveLosses > 0) {
        this.consecutiveLosses = Math.max(
          0,
          this.consecutiveLosses - this.consecutiveLossesReduceOnProfit,
        );
        if (this.consecutiveLosses < this.consecutiveLossesThreshold) {
          this.currentCooldownCandles = this.baseCooldownCandles;
          this.globalCooldownEndIdx = -1;
        }
      }
    }
  }

  isInCooldown(curIdx: number): boolean {
    return curIdx < this.globalCooldownEndIdx;
  }

  getRemainingCooldown(curIdx: number): number {
    if (curIdx >= this.globalCooldownEndIdx) return 0;
    return this.globalCooldownEndIdx - curIdx;
  }
}
