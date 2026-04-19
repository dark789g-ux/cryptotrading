/**
 * 回测引擎主循环 — 精确翻译自 backtest/engine.py
 * 重构点：
 *   1. 冷却机制从 per-symbol setCooldown + LossTracker 改为账户级 CooldownState
 *   2. 主循环新增 candleLog 逐根事件收集
 */

import {
  KlineBarRow,
  Position,
  TradeRecord,
  BacktestConfig,
  CandleLogEntry,
  CandleEntryEvent,
  CandleExitEvent,
  createPosition,
} from './models';
import { calcRecentHigh, calcRecentLow, precomputeAllKdj } from './bt-indicators';
import { processCandle, processEntryCandle } from './position-handler';
import { scanSignals } from './signal-scanner';
import { initCooldown, registerExit, isInCooldown, CooldownState } from './cooldown';
import { createTradeRecord } from './trade-helper';

export interface BacktestResult {
  trades: TradeRecord[];
  portfolioLog: [string, number][];
  posSnapshots: Array<Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }>>;
  /** 逐根 K 线事件日志 */
  candleLog: CandleLogEntry[];
}

// ─────────────────────────────────────────────────────────────
// 内部辅助：执行上一时间步挂单的买入
// ─────────────────────────────────────────────────────────────
const MAX_PENDING_AGE = 3;

/**
 * 执行挂单买入，返回：
 *   - 新的 pendingBuys 列表（未成交部分）
 *   - 更新后的 cash
 *   - 本次实际入场事件列表（CandleEntryEvent[]）
 */
function executePendingBuys(
  pendingBuys: [string, string, number, number][],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
  portfolioLog: [string, number][],
  positions: Position[],
  config: BacktestConfig,
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
    const positionSize = lastNav * config.positionRatio;
    const alloc = Math.min(positionSize, cash);
    if (alloc < config.minOpenCash || alloc <= 0) continue;

    const shares = alloc / openPrice;
    const [recLow, recLowTime] = calcRecentLow(df, curIdx, config.recentLowWindow, config.recentLowBuffer);
    const stopP = config.stopLossMode === 'fixed'
      ? openPrice * (1 - config.fixedStopLossPct / 100)
      : recLow * config.stopLossFactor;
    const [recHigh, recHighTime] = calcRecentHigh(df, curIdx, config.recentHighWindow, config.recentHighBuffer);
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
      initialStop: stopP,
      recentHigh: recHigh,
      recentHighTime: recHighTime,
      recentLowTime: recLowTime,
      entryRrRatio: rrRatio,
      entryReason,
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
    });
  }

  return [newPending, cash, entryEvents];
}

// ─────────────────────────────────────────────────────────────
// 内部辅助：处理所有持仓
// ─────────────────────────────────────────────────────────────
/**
 * 处理当根 K 线各持仓，返回：
 *   - 存活的持仓列表
 *   - 更新后的 cash
 *   - 本根 K 线产生的出场事件列表（CandleExitEvent[]，含完整和半仓）
 */
function processPositions(
  positions: Position[],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
  allTrades: TradeRecord[],
  cooldownState: CooldownState,
  barIdx: number,
  config: BacktestConfig,
): [Position[], number, CandleExitEvent[]] {
  const surviving: Position[] = [];
  const exitEvents: CandleExitEvent[] = [];

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
        pos, df, curIdx, ts, cash, config,
      );
      cash = newCash;
      allTrades.push(...tradeRecs);

      // 收集出场事件
      for (const rec of tradeRecs) {
        exitEvents.push({
          symbol: rec.symbol,
          price: rec.exitPrice,
          shares: rec.shares,
          amount: rec.shares * rec.exitPrice,
          pnl: rec.pnl,
          reason: rec.exitReason,
          isHalf: rec.isHalf,
        });
      }

      if (exited) {
        // 只对非半仓的完整平仓登记冷却
        const last = tradeRecs[tradeRecs.length - 1];
        if (last && !last.isHalf && config.enableCooldown) {
          registerExit(
            cooldownState,
            last.pnl > 0,
            false,
            barIdx,
            config.consecutiveLossesThreshold,
            config.maxCooldownCandles,
          );
        }
      } else {
        surviving.push(pos);
      }
      continue;
    }

    // 常规 K 线处理
    const [action, cashDelta, tradeRecs] = processCandle(pos, df, curIdx, config);
    cash += cashDelta;
    allTrades.push(...tradeRecs);

    // 收集出场事件
    for (const rec of tradeRecs) {
      exitEvents.push({
        symbol: rec.symbol,
        price: rec.exitPrice,
        shares: rec.shares,
        amount: rec.shares * rec.exitPrice,
        pnl: rec.pnl,
        reason: rec.exitReason,
        isHalf: rec.isHalf,
      });
    }

    if (action === 'exit_full') {
      // 只对非半仓的完整平仓登记冷却
      const last = tradeRecs[tradeRecs.length - 1];
      if (last && !last.isHalf && config.enableCooldown) {
        registerExit(
          cooldownState,
          last.pnl > 0,
          false,
          barIdx,
          config.consecutiveLossesThreshold,
          config.maxCooldownCandles,
        );
      }
    } else {
      surviving.push(pos);
    }
  }

  return [surviving, cash, exitEvents];
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

/**
 * 计算 openEquity：cash + Σ(shares × open_price) 对所有当前持仓。
 * 若某持仓在当前 ts 没有 K 线则跳过该持仓（不计入市值）。
 */
function calculateOpenEquity(
  positions: Position[],
  ts: string,
  data: Map<string, KlineBarRow[]>,
  tsToIdx: Map<string, Map<string, number>>,
  cash: number,
): number {
  let holdingValue = 0;
  for (const pos of positions) {
    const df = data.get(pos.symbol);
    if (!df) continue;
    const idxMap = tsToIdx.get(pos.symbol);
    if (!idxMap) continue;
    const curIdx = idxMap.get(ts);
    if (curIdx === undefined) continue;
    holdingValue += pos.shares * df[curIdx].open;
  }
  return cash + holdingValue;
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
  cooldownState: CooldownState,
  lastBarIdx: number,
  config: BacktestConfig,
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
    if (config.enableCooldown) {
      registerExit(
        cooldownState,
        pnl > 0,
        false,
        lastBarIdx,
        config.consecutiveLossesThreshold,
        config.maxCooldownCandles,
      );
    }
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
function yieldToEventLoop(): Promise<void> {
  // setTimeout(0) 确保事件循环经过 poll 阶段（HTTP I/O），setImmediate 不行
  return new Promise((resolve) => setTimeout(resolve, 0));
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

  const timestamps = buildGlobalTimeline(data, backtestStart);

  // 初始化状态
  let cash = config.initialCapital;
  let positions: Position[] = [];
  let pendingBuys: [string, string, number, number][] = [];
  const allTrades: TradeRecord[] = [];
  const portfolioLog: [string, number][] = [];
  const posSnapshots: Array<Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }>> = [];
  const candleLog: CandleLogEntry[] = [];

  // 账户级冷却状态（替换旧的 per-symbol cooldownUntil + LossTracker）
  const cooldownState = initCooldown(config.enableCooldown ? config.baseCooldownCandles : 0);

  const totalBars = timestamps.length;
  const REPORT_EVERY = 100;

  for (let barIdx = 0; barIdx < timestamps.length; barIdx++) {
    const ts = timestamps[barIdx];

    // ── 0. 记录 openEquity（在 executePendingBuys 之前，取 open 价格计算） ──
    const openEquity = calculateOpenEquity(positions, ts, data, tsToIdx, cash);

    // ── 1. 执行上一时间步挂单的买入 ──
    let entryEvents: CandleEntryEvent[];
    [pendingBuys, cash, entryEvents] = executePendingBuys(
      pendingBuys, ts, data, tsToIdx, cash, portfolioLog, positions, config,
    );

    // ── 2. 处理每个持仓 ──
    let exitEvents: CandleExitEvent[];
    [positions, cash, exitEvents] = processPositions(
      positions, ts, data, tsToIdx, cash, allTrades,
      cooldownState, barIdx, config,
    );

    // ── 3. 计算当前持仓市值，同步记录持仓快照 ──
    const [portfolioVal, snapshot] = calculatePortfolioValue(positions, ts, data, tsToIdx, cash);
    portfolioLog.push([ts, portfolioVal]);
    posSnapshots.push(snapshot);

    // ── 4. 判断是否允许开新仓，再按需扫描入场信号 ──
    const nPos = positions.length;
    const allHalf = nPos === config.maxPositions && positions.every((p) => p.halfSold);
    const allowNew = nPos < config.maxPositions || allHalf;

    // 门禁：开启 requireAllPositionsProfitable 时，仅当全部现存持仓满足
    // stopPrice > entryPrice（保本止损已上移至成本之上）方可开新仓；空仓不受限。
    const profitGate =
      !config.requireAllPositionsProfitable ||
      nPos === 0 ||
      positions.every((p) => p.stopPrice > p.entryPrice);

    // 账户级冷却门禁（替换旧 lossTracker.isInCooldown）
    const inCooldownNow = config.enableCooldown ? isInCooldown(cooldownState, barIdx) : false;

    if (allowNew && profitGate && cash >= config.minOpenCash && !inCooldownNow) {
      const slotsToFill = allHalf ? config.maxPositions + 1 - nPos : config.maxPositions - nPos;

      if (slotsToFill > 0) {
        const heldSymbols = new Set<string>(positions.map((p) => p.symbol));
        for (const [sym] of pendingBuys) heldSymbols.add(sym);
        // scanSignals 不再接收 cooldownUntil 参数
        const candidates = scanSignals(data, ts, tsToIdx, heldSymbols, config, precomputedKdj);
        // 有意设计：即使 slotsToFill > 1，也每根只挂 1 单。
        if (candidates.length) {
          const [sym, rr] = candidates[0];
          pendingBuys.push([sym, ts, rr, 0]);
        }
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
      maxPositions: config.maxPositions,
      entries: entryEvents,
      exits: exitEvents,
      openSymbols: positions.map((p) => p.symbol),
      inCooldown: inCooldownNow,
    });

    // 进度回调 + 让出事件循环，确保轮询请求可被处理
    if (barIdx % REPORT_EVERY === 0 || barIdx === totalBars - 1) {
      const pct = totalBars ? ((barIdx + 1) / totalBars) * 100 : 100;
      if (progressCb) progressCb(barIdx + 1, totalBars, pct, ts);
      await yieldToEventLoop();
    }
  }

  // ── 6. 回测结束：强制平仓所有剩余持仓 ──
  // forceClosePositions 产生的 trade 也走 registerExit，但不 push candleLog（主循环已结束）
  cash = forceClosePositions(
    positions, timestamps, data, tsToIdx, cash, allTrades,
    cooldownState, timestamps.length - 1, config,
  );

  return { trades: allTrades, portfolioLog, posSnapshots, candleLog };
}
