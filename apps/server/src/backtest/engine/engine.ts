/**
 * 回测引擎主循环 — 精确翻译自 backtest/engine.py
 * 重构点：
 *   1. 冷却机制从 per-symbol setCooldown + LossTracker 改为账户级 CooldownState
 *   2. 主循环新增 candleLog 逐根事件收集
 *   3. 新增凯利公式动态仓位与模拟期逻辑
 */

import { precomputeAllKdj, precomputeBrickChartAll } from './bt-indicators';
import { initCooldown, isInCooldown } from './cooldown';
import { createPosition, type TradeRecord } from './models';
import { createTradeRecord } from './trade-helper';
import { yieldToEventLoop } from './steps/engine.async';
import type { BacktestResult } from './steps/engine.types';
import { forceClosePositions } from './steps/engine.force-close';
import { executePendingBuys, type KellyContext } from './steps/engine.pending-execution';
import { calculateOpenEquity, calculatePortfolioValue } from './steps/engine.portfolio-marks';
import { processPositions } from './steps/engine.position-processing';
import { buildGlobalTimeline } from './steps/engine.timeline';
import type {
  BacktestConfig,
  CandleEntryEvent,
  CandleExitEvent,
  CandleLogEntry,
  KlineBarRow,
  Position,
} from './models';
import { scanSignals } from './signal-scanner';

export type { BacktestResult } from './steps/engine.types';
export { buildGlobalTimeline } from './steps/engine.timeline';

function updateKellyStats(
  simTrades: TradeRecord[],
  allTrades: TradeRecord[],
  windowSize: number,
): { p: number; b: number; cumP: number; cumB: number } {
  const allCompleted = [...simTrades, ...allTrades].filter((t) => !t.isHalf);
  const windowSamples = allCompleted.slice(-windowSize);

  function calcStats(samples: TradeRecord[]) {
    const wins = samples.filter((t) => t.pnl > 0);
    const losses = samples.filter((t) => t.pnl <= 0);
    const p = samples.length ? wins.length / samples.length : 0;

    let b = 0;
    if (losses.length === 0) {
      if (wins.length > 0) b = 999;
    } else if (wins.length === 0) {
      b = 0;
    } else {
      const avgWin = wins.reduce((s, t) => s + (t.overallReturnPct ?? 0), 0) / wins.length;
      const avgLoss = Math.abs(losses.reduce((s, t) => s + (t.overallReturnPct ?? 0), 0) / losses.length);
      b = avgLoss > 0 ? avgWin / avgLoss : 0;
    }
    return { p, b };
  }

  const cum = calcStats(allCompleted);
  const win = calcStats(windowSamples);
  return { p: win.p, b: win.b, cumP: cum.p, cumB: cum.b };
}

function tradeRecsToExitEvents(tradeRecs: TradeRecord[]): CandleExitEvent[] {
  return tradeRecs.map((rec) => ({
    symbol: rec.symbol,
    price: rec.exitPrice,
    shares: rec.shares,
    amount: rec.shares * rec.exitPrice,
    pnl: rec.pnl,
    reason: rec.exitReason,
    isHalf: rec.isHalf,
    isSimulation: rec.isSimulation ?? false,
    tradePhase: rec.tradePhase ?? 'live',
    overallReturnPct: rec.overallReturnPct,
    cumulativeWinRate: rec.cumulativeWinRate,
    cumulativeOdds: rec.cumulativeOdds,
    windowWinRate: rec.windowWinRate,
    windowOdds: rec.windowOdds,
  }));
}

function forceCloseSimPositions(
  simPositions: Position[],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  simTrades: TradeRecord[],
  tradePhase: 'simulation' | 'probe',
): TradeRecord[] {
  const reason = tradePhase === 'probe' ? '探针模式结束强平' : '模拟期结束强平';
  const tradeRecs: TradeRecord[] = [];
  for (const pos of simPositions) {
    const df = data.get(pos.symbol);
    if (!df) continue;
    const idxMap = tsToIdx.get(pos.symbol);
    if (!idxMap) continue;
    const curIdx = idxMap.get(ts);
    if (curIdx === undefined) continue;

    const closePrice = df[curIdx].close;
    const proceeds = pos.shares * closePrice;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    const holdCandles = Math.max(1, curIdx - pos.entryIdx + 1);
    const rec = createTradeRecord(pos, ts, closePrice, pos.shares, pnl, reason, holdCandles, false);
    rec.isSimulation = true;
    rec.tradePhase = tradePhase;

    simTrades.push(rec);
    tradeRecs.push(rec);
  }
  return tradeRecs;
}

export async function runBacktest(
  data: Map<string, KlineBarRow[]>,
  backtestStart: Map<string, number>,
  config: BacktestConfig,
  progressCb?: (current: number, total: number, pct: number, currentTs: string) => void,
): Promise<BacktestResult> {
  // 构建 ts → row-index 映射
  const tsToIdx = new Map<string, Map<string, number>>();
  for (const [symbol, df] of data) {
    const m = new Map<string, number>();
    df.forEach((row, i) => m.set(String(row.open_time), i));
    tsToIdx.set(symbol, m);
  }

  // 自定义 KDJ 周期时预计算，避免主循环内重复 O(n²) 计算
  const precomputedKdj =
    config.kdjN !== 9 || config.kdjM1 !== 3 || config.kdjM2 !== 3
      ? precomputeAllKdj(data, config.kdjN, config.kdjM1, config.kdjM2)
      : undefined;

  const brickMap = config.brickXgEnabled ? precomputeBrickChartAll(data) : undefined;

  const timestamps = buildGlobalTimeline(data, backtestStart);

  // 初始化状态
  let cash = config.initialCapital;
  let positions: Position[] = [];
  let pendingBuys: [string, string, number, number][] = [];
  const allTrades: TradeRecord[] = [];
  const portfolioLog: [string, number][] = [];
  const posSnapshots: Array<Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }>> = [];
  const candleLog: CandleLogEntry[] = [];

  // 凯利公式模拟期状态
  let simPositions: Position[] = [];
  let simTrades: TradeRecord[] = [];
  let simPortfolioLog: [string, number][] = [];
  let simCash = config.initialCapital;
  let simPendingBuys: [string, string, number, number][] = [];
  let completedTradeCount = 0;
  let currentWindowWinRate = 0;
  let currentWindowOdds = 0;
  const posMeta = new Map<string, { allocated: number; pnlSum: number }>();
  let wasProbeMode = false;

  // 账户级冷却状态（替换旧的 per-symbol cooldownUntil + LossTracker）
  const cooldownState = initCooldown(config.enableCooldown ? config.baseCooldownCandles : 0);

  const totalBars = timestamps.length;
  const REPORT_EVERY = 100;

  const makeKellyCtx = (): KellyContext | undefined => {
    if (!config.enableKellySizing) return undefined;
    return { completedTradeCount, currentWindowWinRate, currentWindowOdds };
  };

  const handleNewTrades = (newTrades: TradeRecord[], phase: 'simulation' | 'probe' | 'live') => {
    const fullExitTrades: TradeRecord[] = [];
    for (const t of newTrades) {
      const key = t.symbol + '|' + t.entryTime;
      const meta = posMeta.get(key);
      if (!meta) continue;
      meta.pnlSum += t.pnl;
      t.isSimulation = phase !== 'live';
      t.tradePhase = phase;
      if (!t.isHalf) {
        t.overallReturnPct = (meta.pnlSum / meta.allocated) * 100;
        posMeta.delete(key);
        fullExitTrades.push(t);
      }
    }

    for (const t of fullExitTrades) {
      completedTradeCount++;
      const stats = updateKellyStats(simTrades, allTrades, config.kellyWindowTrades);
      t.cumulativeWinRate = stats.cumP;
      t.cumulativeOdds = stats.cumB;
      if (completedTradeCount % config.kellyStepTrades === 0) {
        currentWindowWinRate = stats.p;
        currentWindowOdds = stats.b;
      }
      t.windowWinRate = currentWindowWinRate;
      t.windowOdds = currentWindowOdds;
    }
  };

  for (let barIdx = 0; barIdx < timestamps.length; barIdx++) {
    const ts = timestamps[barIdx];
    let entryEvents: CandleEntryEvent[] = [];
    let exitEvents: CandleExitEvent[] = [];

    const isSimPhase = config.enableKellySizing && completedTradeCount < config.kellySimTrades;

    // 计算 kellyRaw（仅在非模拟期且启用凯利时）
    let kellyRaw = 0;
    if (config.enableKellySizing && !isSimPhase) {
      const b = currentWindowOdds;
      const p = currentWindowWinRate;
      if (b > 0 && p > 0) {
        kellyRaw = (b * p - (1 - p)) / b;
      }
    }

    const isProbeMode = config.enableKellySizing && config.enableKellyProbe
      && !isSimPhase
      && kellyRaw <= 0
      && positions.length === 0;

    // 退出 Probe 模式时，强制平掉探针持仓
    if (wasProbeMode && !isProbeMode && simPositions.length > 0) {
      const forcedTrades = forceCloseSimPositions(simPositions, ts, data, tsToIdx, simTrades, 'probe');
      handleNewTrades(forcedTrades, 'probe');
      exitEvents.push(...tradeRecsToExitEvents(forcedTrades));
      simPositions = [];
    }

    // ── 0. 记录 openEquity（在 executePendingBuys 之前，取 open 价格计算） ──
    const openEquity = calculateOpenEquity(positions, ts, data, tsToIdx, cash);

    // ── 1. 执行上一时间步挂单的买入 ──
    if (isSimPhase || isProbeMode) {
      const prevLen = simPositions.length;
      [simPendingBuys, simCash, entryEvents] = executePendingBuys(
        simPendingBuys, ts, data, tsToIdx, simCash, simPortfolioLog, simPositions, config,
        makeKellyCtx(),
        { applyKellySizing: !isProbeMode },
      );
      for (let i = prevLen; i < simPositions.length; i++) {
        const pos = simPositions[i];
        posMeta.set(pos.symbol + '|' + pos.entryTime, { allocated: pos.allocated, pnlSum: 0 });
      }
      const phase = isSimPhase ? 'simulation' : 'probe';
      for (const e of entryEvents) {
        e.isSimulation = true;
        e.tradePhase = phase;
      }
    } else {
      const prevLen = positions.length;
      [pendingBuys, cash, entryEvents] = executePendingBuys(
        pendingBuys, ts, data, tsToIdx, cash, portfolioLog, positions, config, makeKellyCtx(),
      );
      for (let i = prevLen; i < positions.length; i++) {
        const pos = positions[i];
        posMeta.set(pos.symbol + '|' + pos.entryTime, { allocated: pos.allocated, pnlSum: 0 });
      }
      for (const e of entryEvents) {
        e.isSimulation = false;
        e.tradePhase = 'live';
      }
    }

    // ── 2. 处理每个持仓 ──
    if (isSimPhase || isProbeMode) {
      const prevLen = simTrades.length;
      let tradeRecs: TradeRecord[];
      [simPositions, simCash, tradeRecs] = processPositions(
        simPositions, ts, data, tsToIdx, simCash, simTrades,
        cooldownState, barIdx, config, true,
      );
      const phase = isSimPhase ? 'simulation' : 'probe';
      handleNewTrades(simTrades.slice(prevLen), phase);
      exitEvents.push(...tradeRecsToExitEvents(tradeRecs));
    } else {
      const prevLen = allTrades.length;
      let tradeRecs: TradeRecord[];
      [positions, cash, tradeRecs] = processPositions(
        positions, ts, data, tsToIdx, cash, allTrades,
        cooldownState, barIdx, config, false,
      );
      handleNewTrades(allTrades.slice(prevLen), 'live');
      exitEvents.push(...tradeRecsToExitEvents(tradeRecs));
    }

    // 临界点：模拟期结束，强制平掉剩余虚拟持仓
    if (config.enableKellySizing && isSimPhase && completedTradeCount >= config.kellySimTrades) {
      const forcedTrades = forceCloseSimPositions(simPositions, ts, data, tsToIdx, simTrades, 'simulation');
      handleNewTrades(forcedTrades, 'simulation');
      exitEvents.push(...tradeRecsToExitEvents(forcedTrades));
      simPositions = [];
    }

    // ── 3. 计算当前持仓市值，同步记录持仓快照 ──
    if (isSimPhase || isProbeMode) {
      const [simVal] = calculatePortfolioValue(simPositions, ts, data, tsToIdx, simCash);
      simPortfolioLog.push([ts, simVal]);
    }
    const [portfolioVal, snapshot] = calculatePortfolioValue(positions, ts, data, tsToIdx, cash);
    portfolioLog.push([ts, portfolioVal]);
    posSnapshots.push(snapshot);

    // ── 4. 判断是否允许开新仓，再按需扫描入场信号 ──
    const activePositions = isSimPhase ? simPositions : (isProbeMode ? simPositions : positions);
    const nPos = activePositions.length;
    const effectiveMaxPos = config.enableKellySizing ? 1 : config.maxPositions;
    const allowNew = nPos < effectiveMaxPos;

    // 门禁：开启 requireAllPositionsProfitable 时，仅当全部现存持仓满足
    // stopPrice > entryPrice（保本止损已上移至成本之上）方可开新仓；空仓不受限。
    const profitGate =
      !config.requireAllPositionsProfitable ||
      nPos === 0 ||
      activePositions.every((p) => p.stopPrice > p.entryPrice);

    // 账户级冷却门禁（模拟期和探针期不走冷却逻辑）
    const inCooldownNow =
      config.enableCooldown && !isSimPhase && !isProbeMode && isInCooldown(cooldownState, barIdx);

    const activeCash = isSimPhase || isProbeMode ? simCash : cash;
    const activePending = isSimPhase || isProbeMode ? simPendingBuys : pendingBuys;
    if (allowNew && profitGate && activeCash >= config.minOpenCash && !inCooldownNow) {
      const heldSymbols = new Set<string>(activePositions.map((p) => p.symbol));
      for (const [sym] of activePending) heldSymbols.add(sym);
      // scanSignals 不再接收 cooldownUntil 参数
      const candidates = scanSignals(data, ts, tsToIdx, heldSymbols, config, precomputedKdj, brickMap);
      // 有意设计：即使 slotsToFill > 1，也每根只挂 1 单。
      if (candidates.length) {
        const [sym, rr] = candidates[0];
        activePending.push([sym, ts, rr, 0]);
      }
    }

    // ── 5. 推送当根 K 线日志 ──
    // inCooldown 取扫描入场信号时的状态（上方已查询）
    candleLog.push({
      barIdx,
      ts,
      openEquity,
      closeEquity: portfolioVal,
      posCount: positions.length,
      maxPositions: config.enableKellySizing ? 1 : config.maxPositions,
      entries: entryEvents,
      exits: exitEvents,
      openSymbols: positions.map((p) => p.symbol),
      inCooldown: inCooldownNow,
      cooldownDuration: config.enableCooldown ? cooldownState.cooldownDuration : null,
      cooldownRemaining: config.enableCooldown
        ? (inCooldownNow && cooldownState.cooldownUntilBarIdx !== null
            ? cooldownState.cooldownUntilBarIdx - barIdx
            : 0)
        : null,
    });

    wasProbeMode = isProbeMode;

    // 进度回调 + 让出事件循环，确保轮询请求可被处理
    if (barIdx % REPORT_EVERY === 0 || barIdx === totalBars - 1) {
      const pct = totalBars ? ((barIdx + 1) / totalBars) * 100 : 100;
      if (progressCb) progressCb(barIdx + 1, totalBars, pct, ts);
      await yieldToEventLoop();
    }
  }

  // ── 6. 回测结束：强制平仓所有剩余持仓 ──
  // 先处理模拟持仓（若还有剩余）
  if (simPositions.length > 0) {
    const lastTs = timestamps[timestamps.length - 1];
    const forcedTrades = forceCloseSimPositions(simPositions, lastTs, data, tsToIdx, simTrades, wasProbeMode ? 'probe' : 'simulation');
    handleNewTrades(forcedTrades, wasProbeMode ? 'probe' : 'simulation');
    simPositions = [];
  }

  // forceClosePositions 产生的 trade 也走 registerExit，但不 push candleLog（主循环已结束）
  cash = forceClosePositions(
    positions, timestamps, data, tsToIdx, cash, allTrades,
    cooldownState, timestamps.length - 1, config,
  );

  return {
    trades: allTrades,
    simTrades,
    portfolioLog,
    simPortfolioLog,
    posSnapshots,
    candleLog,
  };
}
