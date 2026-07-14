/**
 * 持仓处理器 — 精确翻译自 backtest/position_handler.py
 */

import { KlineBarRow, Position, TradeRecord, BacktestConfig } from './models';
import { createTradeRecord, settleSell } from './trade-helper';

/**
 * 计算当前持仓的 R 倍数（基于 initialStop）。
 * initialStop 无效（等于 entryPrice）时返回 0，避免除零。
 */
function calcR(entryPrice: number, initialStop: number, price: number): number {
  const risk = entryPrice - initialStop;
  if (risk <= 0) return 0;
  return (price - entryPrice) / risk;
}

function calcAdjustedStop(
  entryPrice: number,
  maxClose: number,
  currentStop: number,
  target: 'midpoint' | 'breakeven',
): number {
  const newStop = target === 'midpoint' ? (entryPrice + maxClose) / 2 : entryPrice;
  return Math.max(currentStop, newStop);
}

function applyLadderStopAfterClose(
  pos: Position,
  low: number,
): void {
  if (pos.ladderBreakevenHit && low > pos.stopPrice) {
    pos.stopPrice = low;
    pos.stopReason = '阶梯止损-追踪';
  }

  // 仅在收盘后的阶梯处理段、且完成本轮上移后检查封顶。
  if (pos.stopPrice > pos.signalBarHigh) {
    pos.ladderStopFrozen = true;
    pos.stopReason = '阶梯止损-封顶';
  }
}

/**
 * 收盘后更新止损价（移动止损 & 保本止损）。
 * 仅上移，不下移。
 */
function updateStopAfterClose(pos: Position, close: number, config: BacktestConfig): void {
  if (config.enableTrailingStop) {
    const newStop = pos.maxClose * (1 - config.trailingDrawdownPct / 100);
    if (newStop > pos.stopPrice) {
      pos.stopPrice = newStop;
      pos.stopReason = '移动止损';
    }
  }

  if (config.enableBreakevenStop && !pos.breakevenTriggered) {
    const r = calcR(pos.entryPrice, pos.initialStop, close);
    if (r >= config.breakevenTriggerR && pos.entryPrice > pos.stopPrice) {
      pos.stopPrice = pos.entryPrice;
      pos.stopReason = '保本止损';
      pos.breakevenTriggered = true;
    }
  }
}

/**
 * 分批止盈：按 close R 检查未触发的分批止盈档位，在收盘价卖出。
 * 返回 [cashDelta, tradeRecords, exitedFull]。
 */
function processTakeProfitTargets(
  pos: Position,
  time: string,
  close: number,
  config: BacktestConfig,
): [number, TradeRecord[], boolean] {
  if (!config.takeProfitTargets.length) return [0, [], false];

  let cashDelta = 0;
  const trades: TradeRecord[] = [];
  const closeR = calcR(pos.entryPrice, pos.initialStop, close);

  let i = pos.takeProfitNextTargetIdx;
  while (i < config.takeProfitTargets.length) {
    const target = config.takeProfitTargets[i];
    if (closeR < target.rrRatio) break;
    const sellShares = pos.shares * target.sellRatio;
    if (sellShares <= 0) { i++; continue; }
    const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, close, sellShares, config);
    cashDelta += netProceeds;
    trades.push(createTradeRecord(pos, time, close, sellShares, pnl, `分批止盈第${i + 1}档`, pos.candleCount, true, entryFeePortion, exitFee));
    pos.shares -= sellShares;
    pos.takeProfitNextTargetIdx = i + 1;
    i++;
  }

  if (pos.shares <= 0) return [cashDelta, trades, true];
  return [cashDelta, trades, false];
}

/**
 * 移动止盈：触发后追踪最高 close，回撤超阈值时全平。
 * 返回 [cashDelta, tradeRecords, exitedFull]。
 */
function processTrailingProfit(
  pos: Position,
  time: string,
  close: number,
  config: BacktestConfig,
): [number, TradeRecord[], boolean] {
  if (!config.enableTrailingProfit) return [0, [], false];

  const closeR = calcR(pos.entryPrice, pos.initialStop, close);

  if (!pos.trailingProfitActive) {
    if (closeR >= config.trailingProfitTriggerR) {
      pos.trailingProfitActive = true;
      pos.trailingProfitHighClose = close;
    }
    return [0, [], false];
  }

  pos.trailingProfitHighClose = Math.max(pos.trailingProfitHighClose, close);
  const drawdownThreshold = pos.trailingProfitHighClose * (1 - config.trailingProfitDrawdownPct / 100);
  if (close <= drawdownThreshold) {
    const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, close, pos.shares, config);
    return [
      netProceeds,
      [createTradeRecord(pos, time, close, pos.shares, pnl, '移动止盈', pos.candleCount, false, entryFeePortion, exitFee)],
      true,
    ];
  }

  return [0, [], false];
}

/**
 * 合并后的持仓 K 线处理函数，同时覆盖入场当根和后续 K 线两种场景。
 *
 * 通过 opts.isEntryCandle 区分：
 *   - isEntryCandle=true  : 原 processEntryCandle，处理买入当根
 *   - isEntryCandle=false : 原 processCandle，处理后续持仓 K 线
 *
 * 返回：{ action, cashDelta, trades }
 *   action:    null | "exit_full"   — 是否完整出场
 *   cashDelta:  增量（调用方 cash += cashDelta）
 *   trades:     本根产生的交易记录
 */
export interface ProcessCandleOpts {
  isEntryCandle: boolean;
  ts: string;
}

export function processPositionCandle(
  pos: Position,
  df: KlineBarRow[],
  curIdx: number,
  config: BacktestConfig,
  opts: ProcessCandleOpts,
): { action: string | null; cashDelta: number; trades: TradeRecord[] } {
  const { isEntryCandle, ts } = opts;

  const row = df[curIdx];
  const open = row.open;
  const high = row.high;
  const low = row.low;
  const close = row.close;
  const ma5 = row.MA5 as number;

  const prevMa5 = curIdx > 0 ? df[curIdx - 1].MA5 as number : ma5;

  const trades: TradeRecord[] = [];
  let cashDelta = 0;

  // ── 差异 1：holdCandles 用于 trade record ──
  const holdCandles = isEntryCandle ? 0 : pos.candleCount;

  // ──────────────────────────────────────────────────
  // 步骤 1+2：阶段止盈 与 止损
  // ──────────────────────────────────────────────────
  const hitProfit = config.enablePartialProfit && !pos.halfSold && high >= pos.recentHigh;
  const hitStop = low <= pos.stopPrice;

  const highFirst = Math.abs(open - high) < Math.abs(open - low);

  if (!highFirst && hitStop) {
    // ── 差异 2：止损 exitPrice ──
    const exitPrice = isEntryCandle ? pos.stopPrice : (open < pos.stopPrice ? open : pos.stopPrice);
    const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, exitPrice, pos.shares, config);
    cashDelta += netProceeds;
    trades.push(createTradeRecord(pos, ts, exitPrice, pos.shares, pnl, pos.stopReason, holdCandles, false, entryFeePortion, exitFee));
    return { action: 'exit_full', cashDelta, trades };
  }

  if (hitProfit) {
    const halfShares = pos.shares * config.partialProfitRatio;
    const sellPrice = pos.recentHigh;
    const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, sellPrice, halfShares, config);
    trades.push(createTradeRecord(pos, ts, sellPrice, halfShares, pnl, '阶段止盈', holdCandles, true, entryFeePortion, exitFee));
    pos.shares -= halfShares;
    pos.halfSold = true;
    pos.halfSellPrice = sellPrice;
    pos.halfSellTime = ts;
    cashDelta += netProceeds;
  }

  if (hitStop) {
    // ── 差异 2：止损 exitPrice（同上）──
    const exitPrice = isEntryCandle ? pos.stopPrice : (open < pos.stopPrice ? open : pos.stopPrice);
    const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, exitPrice, pos.shares, config);
    cashDelta += netProceeds;
    trades.push(createTradeRecord(pos, ts, exitPrice, pos.shares, pnl, pos.stopReason, holdCandles, false, entryFeePortion, exitFee));
    return { action: 'exit_full', cashDelta, trades };
  }

  // ──────────────────────────────────────────────────
  // 步骤 3：收盘处理
  // ──────────────────────────────────────────────────

  // ①' 阶段止盈后止损调节
  if (hitProfit && config.enableProfitStopAdjust) {
    pos.maxClose = Math.max(pos.maxClose, close);
    const newStop = calcAdjustedStop(pos.entryPrice, pos.maxClose, pos.stopPrice, config.profitStopAdjustTo);
    pos.stopPrice = newStop;
    pos.stopReason = config.profitStopAdjustTo === 'breakeven' ? '阶段止盈后保本' : '阶段止盈后止损';
    if (close < newStop) {
      const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, close, pos.shares, config);
      cashDelta += netProceeds;
      trades.push(createTradeRecord(pos, ts, close, pos.shares, pnl, '阶段止盈后收盘止损', holdCandles, false, entryFeePortion, exitFee));
      return { action: 'exit_full', cashDelta, trades };
    }
  }

  // ② MA5 收盘规则
  pos.maxClose = Math.max(pos.maxClose, close);

  if (!pos.brokeMa5 && close > ma5) {
    pos.brokeMa5 = true;
  }

  if (close < ma5 && ma5 <= prevMa5 && pos.brokeMa5) {
    const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, close, pos.shares, config);
    cashDelta += netProceeds;
    trades.push(createTradeRecord(pos, ts, close, pos.shares, pnl, 'MA5下跌破线', holdCandles, false, entryFeePortion, exitFee));
    return { action: 'exit_full', cashDelta, trades };
  }

  if (!pos.ma5StopAdjusted && ma5 > prevMa5 && config.enableMa5StopAdjust) {
    const newStop = calcAdjustedStop(pos.entryPrice, pos.maxClose, pos.stopPrice, config.ma5StopAdjustTo);
    if (close < newStop) {
      const { netProceeds, exitFee, entryFeePortion, pnl } = settleSell(pos, close, pos.shares, config);
      cashDelta += netProceeds;
      trades.push(createTradeRecord(pos, ts, close, pos.shares, pnl, 'MA5上升后止损', holdCandles, false, entryFeePortion, exitFee));
      return { action: 'exit_full', cashDelta, trades };
    } else {
      if (newStop > pos.stopPrice) pos.stopReason = config.ma5StopAdjustTo === 'breakeven' ? 'MA5上升后保本' : 'MA5首次上升止损';
      pos.stopPrice = newStop;
      pos.ma5StopAdjusted = true;
    }
  } else if (!pos.ma5StopAdjusted && ma5 > prevMa5) {
    pos.ma5StopAdjusted = true;
  }

  // ②' 阶梯追踪止损
  // ── 差异 3：阶梯止损初始化（入场当根独有）──
  if (config.enableLadderStopLoss && !pos.ladderStopFrozen) {
    if (isEntryCandle) {
      // 入场当根独有：barUp 判断、ladderStopFrozen、ladderBreakevenHit=true
      if (!pos.ladderBreakevenHit) {
        const barUp = close > open;
        const target = barUp ? pos.entryPrice : low;
        const newStop = Math.max(pos.stopPrice, target);
        if (newStop > pos.stopPrice) {
          pos.stopPrice = newStop;
          pos.stopReason = barUp ? '阶梯止损-保本' : '阶梯止损-入场阴';
        }
        pos.ladderBreakevenHit = true;
      }
      applyLadderStopAfterClose(pos, low);
    } else {
      applyLadderStopAfterClose(pos, low);
    }
  }

  // ③ 分批止盈（收盘 R 检查）
  const [tpCash, tpTrades, tpExited] = processTakeProfitTargets(pos, ts, close, config);
  cashDelta += tpCash;
  trades.push(...tpTrades);
  if (tpExited) return { action: 'exit_full', cashDelta, trades };

  // ④ 移动止盈
  const [trpCash, trpTrades, trpExited] = processTrailingProfit(pos, ts, close, config);
  cashDelta += trpCash;
  trades.push(...trpTrades);
  if (trpExited) return { action: 'exit_full', cashDelta, trades };

  // ⑤ 更新止损价（移动止损、保本止损）
  updateStopAfterClose(pos, close, config);

  // ── 差异 1（续）：candleCount 自增（入场当根跳过）──
  if (!isEntryCandle) {
    pos.candleCount += 1;
  }

  return { action: null, cashDelta, trades };
}
