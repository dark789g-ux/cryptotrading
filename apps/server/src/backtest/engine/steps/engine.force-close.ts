import type { CooldownState } from '../cooldown';
import { registerExit } from '../cooldown';
import type { BacktestConfig, KlineBarRow, Position, TradeRecord } from '../models';
import { createTradeRecord } from '../trade-helper';

export function forceClosePositions(
  positions: Position[],
  timestamps: string[],
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
  allTrades: TradeRecord[],
  cooldownState: CooldownState,
  lastBarIdx: number,
  config: BacktestConfig,
  skipCooldown = false,
): number {
  if (!positions.length || !timestamps.length) return cash;

  const lastTs = timestamps[timestamps.length - 1];

  for (const pos of positions) {
    const df = data.get(pos.symbol);
    if (!df) continue;
    const idxMap = tsToIdx.get(pos.symbol);
    if (!idxMap) continue;

    let curIdx = idxMap.get(lastTs);
    if (curIdx === undefined) {
      // 找最近可用 K 线
      let bestTs = '';
      for (const [t] of idxMap) {
        if (t <= lastTs && t > bestTs) bestTs = t;
      }
      if (!bestTs) continue;
      curIdx = idxMap.get(bestTs)!;
    }

    const closePrice = df[curIdx].close;
    const proceeds = pos.shares * closePrice;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cash += proceeds;

    // 按 df 实际索引差计算持有根数，避免因主循环中 ts 缺失而少计
    const holdCandles = Math.max(1, curIdx - pos.entryIdx + 1);
    const tradeRecord = createTradeRecord(pos, lastTs, closePrice, pos.shares, pnl, '回测结束', holdCandles, false);
    allTrades.push(tradeRecord);

    // 强制平仓也登记冷却（isHalf=false）
    if (config.enableCooldown && !skipCooldown) {
      registerExit(
        cooldownState,
        pnl > 0,
        false,
        lastBarIdx,
        config.consecutiveLossesThreshold,
        config.maxCooldownCandles,
        config.cooldownExtendOnLoss,
        config.cooldownReduceOnProfit,
      );
    }
  }

  return cash;
}
