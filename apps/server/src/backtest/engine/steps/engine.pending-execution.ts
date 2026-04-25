import { calcRecentHigh, calcRecentLow } from '../bt-indicators';
import {
  createPosition,
  type BacktestConfig,
  type CandleEntryEvent,
  type KlineBarRow,
  type Position,
} from '../models';

const MAX_PENDING_AGE = 3;

/**
 * 执行挂单买入，返回：
 *   - 新的 pendingBuys 列表（未成交部分）
 *   - 更新后的 cash
 *   - 本次实际入场事件列表（CandleEntryEvent[]）
 */
export interface KellyContext {
  completedTradeCount: number;
  currentWindowWinRate: number;
  currentWindowOdds: number;
}

export function executePendingBuys(
  pendingBuys: [string, string, number, number][],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
  portfolioLog: [string, number][],
  positions: Position[],
  config: BacktestConfig,
  kellyCtx?: KellyContext,
): [[string, string, number, number][], number, CandleEntryEvent[]] {
  const newPending: [string, string, number, number][] = [];
  const entryEvents: CandleEntryEvent[] = [];

  for (const [sym, sigTs, rrRatio, age] of pendingBuys) {
    const df = data.get(sym);
    if (!df) continue;
    const idxMap = tsToIdx.get(sym);
    if (!idxMap) continue;
    const curIdx = idxMap.get(ts);
    if (curIdx === undefined) {
      // 该 symbol 在当前全局时间点没有 K 线；超过 MAX_PENDING_AGE 根仍无数据则放弃挂单
      if (age + 1 < MAX_PENDING_AGE) {
        newPending.push([sym, sigTs, rrRatio, age + 1]);
      }
      continue;
    }

    const openPrice = df[curIdx].open;
    const lastNav = portfolioLog.length ? portfolioLog[portfolioLog.length - 1][1] : config.initialCapital;

    let positionRatio = config.positionRatio;
    let kellyRaw: number | undefined;
    let kellyAdjusted: number | undefined;
    let windowWinRate: number | undefined;
    let windowOdds: number | undefined;
    const hasKellySnapshot =
      kellyCtx &&
      config.enableKellySizing &&
      kellyCtx.completedTradeCount >= config.kellySimTrades;
    if (hasKellySnapshot) {
      const b = kellyCtx.currentWindowOdds;
      const p = kellyCtx.currentWindowWinRate;
      const q = 1 - p;
      kellyRaw = 0;
      if (b > 0 && p > 0) {
        kellyRaw = (b * p - q) / b;
      }
      kellyAdjusted = Math.max(0, kellyRaw * config.kellyFraction);
      positionRatio = Math.min(kellyAdjusted, config.kellyMaxPositionRatio, config.positionRatio);
      windowWinRate = p;
      windowOdds = b;
    }

    if (positionRatio <= 0) continue;

    const positionSize = lastNav * positionRatio;
    const alloc = Math.min(positionSize, cash);
    if (alloc < config.minOpenCash || alloc <= 0) continue;

    const shares = alloc / openPrice;
    const [recLow, recLowTime] = calcRecentLow(df, curIdx, config.recentLowWindow, config.recentLowBuffer);
    let stopP: number;
    let midPrice: number | undefined;
    let signalBar: KlineBarRow | null = null;
    if (config.stopLossMode === 'fixed') {
      stopP = openPrice * (1 - config.fixedStopLossPct / 100);
      const sigIdx = idxMap.get(sigTs);
      signalBar = sigIdx !== undefined ? df[sigIdx] : null;
    } else if (config.stopLossMode === 'signal_midpoint') {
      const sigIdx = idxMap.get(sigTs);
      signalBar = sigIdx !== undefined ? df[sigIdx] : null;
      midPrice = signalBar ? (signalBar.open + signalBar.close) / 2 : openPrice;
      stopP = midPrice * config.stopLossFactor;
    } else {
      stopP = recLow * config.stopLossFactor;
      const sigIdx = idxMap.get(sigTs);
      signalBar = sigIdx !== undefined ? df[sigIdx] : null;
    }
    const signalBarHigh = signalBar ? signalBar.high : openPrice;
    const [recHigh, recHighTime] = calcRecentHigh(df, curIdx, config.recentHighWindow, config.recentHighBuffer);
    const initStopLossPct = openPrice > 0 ? ((openPrice - stopP) / openPrice) * 100 : 0;

    const entryReason =
      `盈亏比 ${rrRatio.toFixed(2)}\n` +
      (config.stopLossMode === 'signal_midpoint'
        ? `信号K线中点价 ${(midPrice ?? openPrice).toPrecision(6)} (因子 ${config.stopLossFactor})\n`
        : `阶段高点 ${recHighTime} ${recHigh.toPrecision(6)}\n阶段低点 ${recLowTime} ${recLow.toPrecision(6)}\n`) +
      `初次止损幅度 ${initStopLossPct.toFixed(2)}%`;

    const pos = createPosition({
      symbol: sym,
      entryPrice: openPrice,
      entryTime: ts,
      entryIdx: curIdx,
      shares,
      allocated: alloc,
      stopPrice: stopP,
      initialStop: stopP,
      recentHigh: recHigh,
      recentHighTime: recHighTime,
      recentLowTime: recLowTime,
      entryRrRatio: rrRatio,
      entryReason,
      signalBarHigh,
    });
    cash -= alloc;
    positions.push(pos);

    // 记录入场事件
    entryEvents.push({
      symbol: sym,
      price: openPrice,
      shares,
      amount: alloc,
      reason: entryReason,
      isSimulation: false,
      tradePhase: 'live',
      ...(hasKellySnapshot
        ? {
            kellyRaw,
            kellyAdjusted,
            positionRatio,
            windowWinRate,
            windowOdds,
          }
        : {}),
    });
  }

  return [newPending, cash, entryEvents];
}
