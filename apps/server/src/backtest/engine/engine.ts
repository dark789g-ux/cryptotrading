/**
 * 回测引擎主循环 — 精确翻译自 backtest/engine.py
 * 重构点：
 *   1. 冷却机制从 per-symbol setCooldown + LossTracker 改为账户级 CooldownState
 *   2. 主循环新增 candleLog 逐根事件收集
 */

import { precomputeAllKdj, precomputeBrickChartAll } from './bt-indicators';
import { initCooldown, isInCooldown } from './cooldown';
import { yieldToEventLoop } from './steps/engine.async';
import type { BacktestResult } from './steps/engine.types';
import { forceClosePositions } from './steps/engine.force-close';
import { executePendingBuys } from './steps/engine.pending-execution';
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
  TradeRecord,
} from './models';
import { scanSignals } from './signal-scanner';

export type { BacktestResult } from './steps/engine.types';
export { buildGlobalTimeline } from './steps/engine.timeline';

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
        const candidates = scanSignals(data, ts, tsToIdx, heldSymbols, config, precomputedKdj, brickMap);
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
      cooldownDuration: config.enableCooldown ? cooldownState.cooldownDuration : null,
      cooldownRemaining: config.enableCooldown
        ? (inCooldownNow && cooldownState.cooldownUntilBarIdx !== null
            ? cooldownState.cooldownUntilBarIdx - barIdx
            : 0)
        : null,
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
