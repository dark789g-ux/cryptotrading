/**
 * 回测引擎主循环 — 精确翻译自 backtest/engine.py
 */

import { KlineBarRow, Position, TradeRecord, BacktestConfig, createPosition } from './models';
import { calcRecentHigh, calcRecentLow } from './bt-indicators';
import { processCandle, processEntryCandle } from './position-handler';
import { scanSignals } from './signal-scanner';
import { setCooldown } from './cooldown';
import { LossTracker } from './loss-tracker';
import { createTradeRecord } from './trade-helper';

export interface BacktestResult {
  trades: TradeRecord[];
  portfolioLog: [string, number][];
  posSnapshots: Array<Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }>>;
}

// ─────────────────────────────────────────────────────────────
// 内部辅助：执行上一时间步挂单的买入
// ─────────────────────────────────────────────────────────────
function executePendingBuys(
  pendingBuys: [string, string, number][],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
  portfolioLog: [string, number][],
  positions: Position[],
  config: BacktestConfig,
): [[string, string, number][], number] {
  const newPending: [string, string, number][] = [];

  for (const [sym, sigTs, rrRatio] of pendingBuys) {
    const df = data.get(sym);
    if (!df) continue;
    const idxMap = tsToIdx.get(sym);
    if (!idxMap) continue;
    const curIdx = idxMap.get(ts);
    if (curIdx === undefined) {
      newPending.push([sym, sigTs, rrRatio]);
      continue;
    }

    const openPrice = df[curIdx].open;
    const lastNav = portfolioLog.length ? portfolioLog[portfolioLog.length - 1][1] : config.initialCapital;
    const positionSize = lastNav * config.positionRatio;
    const alloc = Math.min(positionSize, cash);
    if (alloc < config.minOpenCash || alloc <= 0) continue;

    const shares = alloc / openPrice;
    const [recLow, recLowTime] = calcRecentLow(df, curIdx, config.lookbackBuffer);
    const stopP = recLow * config.stopLossFactor;
    const [recHigh, recHighTime] = calcRecentHigh(df, curIdx, config.lookbackBuffer);
    const initStopLossPct = openPrice > 0 ? ((openPrice - recLow) / openPrice) * 100 : 0;

    const entryReason =
      `盈亏比 ${rrRatio.toFixed(2)}\n` +
      `阶段高点 ${recHighTime} ${recHigh.toPrecision(6)}\n` +
      `阶段低点 ${recLowTime} ${recLow.toPrecision(6)}\n` +
      `初次止损幅度 ${initStopLossPct.toFixed(2)}%`;

    const pos = createPosition({
      symbol: sym,
      entryPrice: openPrice,
      entryTime: ts,
      entryIdx: curIdx,
      shares,
      allocated: alloc,
      stopPrice: stopP,
      recentHigh: recHigh,
      recentHighTime: recHighTime,
      recentLowTime: recLowTime,
      entryRrRatio: rrRatio,
      entryReason,
    });
    cash -= alloc;
    positions.push(pos);
  }

  return [newPending, cash];
}

// ─────────────────────────────────────────────────────────────
// 内部辅助：处理所有持仓
// ─────────────────────────────────────────────────────────────
function processPositions(
  positions: Position[],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
  allTrades: TradeRecord[],
  cooldownUntil: Map<string, string>,
  lossTracker: LossTracker,
  tsToGlobalIdx: Map<string, number>,
  config: BacktestConfig,
): [Position[], number] {
  const surviving: Position[] = [];

  for (const pos of positions) {
    const df = data.get(pos.symbol);
    if (!df) { surviving.push(pos); continue; }
    const idxMap = tsToIdx.get(pos.symbol);
    if (!idxMap) { surviving.push(pos); continue; }
    const curIdx = idxMap.get(ts);
    if (curIdx === undefined) { surviving.push(pos); continue; }

    if (ts === pos.entryTime) {
      // 买入当根特殊处理
      const [newCash, tradeRecs, exited] = processEntryCandle(
        pos, df, curIdx, ts, cash, cooldownUntil,
        config.enablePartialProfit, config.cooldownHours,
      );
      cash = newCash;
      allTrades.push(...tradeRecs);
      if (exited) {
        const last = tradeRecs[tradeRecs.length - 1];
        if (last && !last.isHalf) {
          lossTracker.processTrade(last, tsToGlobalIdx.get(ts) ?? 0);
        }
      } else {
        surviving.push(pos);
      }
      continue;
    }

    // 常规 K 线处理
    const [action, cashDelta, tradeRecs] = processCandle(pos, df, curIdx, config.enablePartialProfit);
    cash += cashDelta;
    allTrades.push(...tradeRecs);

    if (action === 'exit_full') {
      setCooldown(cooldownUntil, pos.symbol, ts, config.cooldownHours);
      const last = tradeRecs[tradeRecs.length - 1];
      if (last && !last.isHalf) {
        lossTracker.processTrade(last, tsToGlobalIdx.get(ts) ?? 0);
      }
    } else {
      surviving.push(pos);
    }
  }

  return [surviving, cash];
}

// ─────────────────────────────────────────────────────────────
// 内部辅助：计算当前持仓市值与快照
// ─────────────────────────────────────────────────────────────
function calculatePortfolioValue(
  positions: Position[],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
): [number, Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }>] {
  let holdingValue = 0;
  const snapshot: Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }> = [];

  for (const pos of positions) {
    const df = data.get(pos.symbol);
    if (!df) continue;
    const idxMap = tsToIdx.get(pos.symbol);
    if (!idxMap) continue;
    const curIdx = idxMap.get(ts);
    if (curIdx === undefined) continue;
    const closePrice = df[curIdx].close;
    holdingValue += pos.shares * closePrice;
    const pnlPct = pos.entryPrice ? ((closePrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
    snapshot.push({
      symbol: pos.symbol,
      entryTime: pos.entryTime,
      holdH: pos.candleCount,
      pnlPct: Math.round(pnlPct * 100) / 100,
    });
  }

  return [cash + holdingValue, snapshot];
}

// ─────────────────────────────────────────────────────────────
// 内部辅助：回测结束强制平仓
// ─────────────────────────────────────────────────────────────
function forceClosePositions(
  positions: Position[],
  timestamps: string[],
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
  allTrades: TradeRecord[],
  lossTracker: LossTracker,
  tsToGlobalIdx: Map<string, number>,
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
      // find latest available index ≤ lastTs
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

    const tradeRecord = createTradeRecord(pos, lastTs, closePrice, pos.shares, pnl, '回测结束', pos.candleCount, false);
    allTrades.push(tradeRecord);
    lossTracker.processTrade(tradeRecord, tsToGlobalIdx.get(lastTs) ?? 0);
  }

  return cash;
}

// ─────────────────────────────────────────────────────────────
// 构建全局时间轴
// ─────────────────────────────────────────────────────────────
export function buildGlobalTimeline(
  data: Map<string, KlineBarRow[]>,
  backtestStart: Map<string, number>,
): string[] {
  const times = new Set<string>();
  for (const [symbol, df] of data) {
    const bstart = backtestStart.get(symbol) ?? 0;
    for (let i = bstart; i < df.length; i++) {
      times.add(String(df[i].open_time));
    }
  }
  return Array.from(times).sort();
}

// ─────────────────────────────────────────────────────────────
// 主回测入口
// ─────────────────────────────────────────────────────────────
export function runBacktest(
  data: Map<string, KlineBarRow[]>,
  backtestStart: Map<string, number>,
  config: BacktestConfig,
  progressCb?: (current: number, total: number, pct: number) => void,
): BacktestResult {
  // 构建 ts → row-index 映射
  const tsToIdx = new Map<string, Map<string, number>>();
  for (const [symbol, df] of data) {
    const m = new Map<string, number>();
    df.forEach((row, i) => m.set(String(row.open_time), i));
    tsToIdx.set(symbol, m);
  }

  const timestamps = buildGlobalTimeline(data, backtestStart);
  const tsToGlobalIdx = new Map<string, number>();
  timestamps.forEach((ts, i) => tsToGlobalIdx.set(ts, i));

  // 初始化状态
  let cash = config.initialCapital;
  let positions: Position[] = [];
  let pendingBuys: [string, string, number][] = [];
  const allTrades: TradeRecord[] = [];
  const portfolioLog: [string, number][] = [];
  const posSnapshots: Array<Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }>> = [];
  const cooldownUntil = new Map<string, string>();
  const lossTracker = new LossTracker(
    config.baseCooldownCandles,
    config.maxCooldownCandles,
    config.consecutiveLossesThreshold,
    config.consecutiveLossesReduceOnProfit,
  );

  const totalBars = timestamps.length;
  const REPORT_EVERY = 100;

  for (let barIdx = 0; barIdx < timestamps.length; barIdx++) {
    const ts = timestamps[barIdx];

    // ── 1. 执行上一时间步挂单的买入 ──
    [pendingBuys, cash] = executePendingBuys(
      pendingBuys, ts, data, tsToIdx, cash, portfolioLog, positions, config,
    );

    // ── 2. 处理每个持仓 ──
    [positions, cash] = processPositions(
      positions, ts, data, tsToIdx, cash, allTrades,
      cooldownUntil, lossTracker, tsToGlobalIdx, config,
    );

    // ── 3. 计算当前持仓市值，同步记录持仓快照 ──
    const [portfolioVal, snapshot] = calculatePortfolioValue(positions, ts, data, tsToIdx, cash);
    portfolioLog.push([ts, portfolioVal]);
    posSnapshots.push(snapshot);

    // ── 4. 判断是否允许开新仓，再按需扫描入场信号 ──
    const nPos = positions.length;
    const allHalf = nPos === config.maxPositions && positions.every((p) => p.halfSold);
    const allowNew = nPos < config.maxPositions || allHalf;

    const curGlobalIdx = tsToGlobalIdx.get(ts) ?? 0;

    if (allowNew && cash >= config.minOpenCash && !lossTracker.isInCooldown(curGlobalIdx)) {
      const slotsToFill = allHalf ? config.maxPositions + 1 - nPos : config.maxPositions - nPos;

      if (slotsToFill > 0) {
        const heldSymbols = new Set<string>(positions.map((p) => p.symbol));
        for (const [sym] of pendingBuys) heldSymbols.add(sym);
        const candidates = scanSignals(data, ts, tsToIdx, heldSymbols, cooldownUntil, config);
        if (candidates.length) {
          const [sym, rr] = candidates[0];
          pendingBuys.push([sym, ts, rr]);
        }
      }
    }

    // 进度回调
    if (progressCb && (barIdx % REPORT_EVERY === 0 || barIdx === totalBars - 1)) {
      const pct = totalBars ? ((barIdx + 1) / totalBars) * 100 : 100;
      progressCb(barIdx + 1, totalBars, pct);
    }
  }

  // ── 5. 回测结束：强制平仓所有剩余持仓 ──
  cash = forceClosePositions(
    positions, timestamps, data, tsToIdx, cash, allTrades, lossTracker, tsToGlobalIdx,
  );

  return { trades: allTrades, portfolioLog, posSnapshots };
}
