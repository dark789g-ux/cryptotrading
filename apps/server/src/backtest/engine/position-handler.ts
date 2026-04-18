/**
 * 持仓处理器 — 精确翻译自 backtest/position_handler.py
 */

import { KlineBarRow, Position, TradeRecord, BacktestConfig } from './models';
import { createTradeRecord } from './trade-helper';

/**
 * 计算当前持仓的 R 倍数（基于 initialStop）。
 * initialStop 无效（等于 entryPrice）时返回 0，避免除零。
 */
function calcR(entryPrice: number, initialStop: number, price: number): number {
  const risk = entryPrice - initialStop;
  if (risk <= 0) return 0;
  return (price - entryPrice) / risk;
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
    const pnl = sellShares * (close - pos.entryPrice);
    cashDelta += sellShares * close;
    trades.push(createTradeRecord(pos, time, close, sellShares, pnl, `分批止盈第${i + 1}档`, pos.candleCount, true));
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
    const proceeds = pos.shares * close;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    return [
      proceeds,
      [createTradeRecord(pos, time, close, pos.shares, pnl, '移动止盈', pos.candleCount, false)],
      true,
    ];
  }

  return [0, [], false];
}

/**
 * 处理持仓 pos 在 curIdx 这根 K 线上的事件。
 *
 * 返回：[action, cashDelta, tradeRecords]
 *   action: null | "exit_full" | "half_sold"
 */
export function processCandle(
  pos: Position,
  df: KlineBarRow[],
  curIdx: number,
  config: BacktestConfig,
): [string | null, number, TradeRecord[]] {
  const row = df[curIdx];
  const open = row.open;
  const high = row.high;
  const low = row.low;
  const close = row.close;
  const ma5 = row.MA5 as number;
  const time = String(row.open_time);

  const trades: TradeRecord[] = [];
  let cashDelta = 0;

  const prevMa5 = curIdx > 0 ? df[curIdx - 1].MA5 as number : ma5;

  // ──────────────────────────────────────────────────
  // 步骤 1+2：阶段止盈 与 止损
  // ──────────────────────────────────────────────────
  const hitProfit = config.enablePartialProfit && !pos.halfSold && high >= pos.recentHigh;
  const hitStop = low <= pos.stopPrice;

  const highFirst = Math.abs(open - high) < Math.abs(open - low);

  if (!highFirst && hitStop) {
    const exitPrice = open < pos.stopPrice ? open : pos.stopPrice;
    const proceeds = pos.shares * exitPrice;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cashDelta += proceeds;
    trades.push(createTradeRecord(pos, time, exitPrice, pos.shares, pnl, pos.stopReason, pos.candleCount, false));
    return ['exit_full', cashDelta, trades];
  }

  if (hitProfit) {
    const halfShares = pos.shares * config.partialProfitRatio;
    const sellPrice = pos.recentHigh;
    const proceedsHalf = halfShares * sellPrice;
    const pnlHalf = proceedsHalf - halfShares * pos.entryPrice;
    trades.push(createTradeRecord(pos, time, sellPrice, halfShares, pnlHalf, '阶段止盈', pos.candleCount, true));
    pos.shares -= halfShares;
    pos.halfSold = true;
    pos.halfSellPrice = sellPrice;
    pos.halfSellTime = time;
    cashDelta += proceedsHalf;
  }

  if (hitStop) {
    const exitPrice = open < pos.stopPrice ? open : pos.stopPrice;
    const proceeds = pos.shares * exitPrice;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cashDelta += proceeds;
    trades.push(createTradeRecord(pos, time, exitPrice, pos.shares, pnl, pos.stopReason, pos.candleCount, false));
    return ['exit_full', cashDelta, trades];
  }

  // ──────────────────────────────────────────────────
  // 步骤 3：收盘处理
  // ──────────────────────────────────────────────────

  // ①' 阶段止盈后止损调节
  if (hitProfit) {
    pos.maxClose = Math.max(pos.maxClose, close);
    let newStop = (pos.entryPrice + pos.maxClose) / 2;
    newStop = Math.max(pos.stopPrice, newStop);
    pos.stopPrice = newStop;
    pos.stopReason = '阶段止盈后止损';
    if (close < newStop) {
      const proceeds = pos.shares * close;
      const pnl = proceeds - pos.shares * pos.entryPrice;
      cashDelta += proceeds;
      trades.push(createTradeRecord(pos, time, close, pos.shares, pnl, '阶段止盈后收盘止损', pos.candleCount, false));
      return ['exit_full', cashDelta, trades];
    }
  }

  // ② MA5 收盘规则
  pos.maxClose = Math.max(pos.maxClose, close);

  if (!pos.brokeMa5 && close > ma5) {
    pos.brokeMa5 = true;
  }

  if (close < ma5 && ma5 <= prevMa5 && pos.brokeMa5) {
    const proceeds = pos.shares * close;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cashDelta += proceeds;
    trades.push(createTradeRecord(pos, time, close, pos.shares, pnl, 'MA5下跌破线', pos.candleCount, false));
    return ['exit_full', cashDelta, trades];
  }

  if (!pos.ma5StopAdjusted && ma5 > prevMa5) {
    let newStop = (pos.entryPrice + pos.maxClose) / 2;
    newStop = Math.max(pos.stopPrice, newStop);
    if (close < newStop) {
      const proceeds = pos.shares * close;
      const pnl = proceeds - pos.shares * pos.entryPrice;
      cashDelta += proceeds;
      trades.push(createTradeRecord(pos, time, close, pos.shares, pnl, 'MA5上升后止损', pos.candleCount, false));
      return ['exit_full', cashDelta, trades];
    } else {
      if (newStop > pos.stopPrice) pos.stopReason = 'MA5首次上升止损';
      pos.stopPrice = newStop;
      pos.ma5StopAdjusted = true;
    }
  }

  // ③ 分批止盈（收盘 R 检查）
  const [tpCash, tpTrades, tpExited] = processTakeProfitTargets(pos, time, close, config);
  cashDelta += tpCash;
  trades.push(...tpTrades);
  if (tpExited) return ['exit_full', cashDelta, trades];

  // ④ 移动止盈
  const [trpCash, trpTrades, trpExited] = processTrailingProfit(pos, time, close, config);
  cashDelta += trpCash;
  trades.push(...trpTrades);
  if (trpExited) return ['exit_full', cashDelta, trades];

  // ⑤ 更新止损价（移动止损、保本止损）
  updateStopAfterClose(pos, close, config);

  pos.candleCount += 1;
  return [null, cashDelta, trades];
}


/**
 * 处理买入当根 K 线的止盈与止损检查。
 *
 * 返回：[newCash, trades, exited]
 */
export function processEntryCandle(
  pos: Position,
  df: KlineBarRow[],
  curIdx: number,
  ts: string,
  cash: number,
  config: BacktestConfig,
): [number, TradeRecord[], boolean] {
  const trades: TradeRecord[] = [];
  const entryOpen = df[curIdx].open;
  const entryLow = df[curIdx].low;
  const entryHigh = df[curIdx].high;
  const close = df[curIdx].close;
  const ma5Cur = df[curIdx].MA5 as number;
  const ma5Prev = curIdx > 0 ? df[curIdx - 1].MA5 as number : ma5Cur;

  const hitProfit = config.enablePartialProfit && !pos.halfSold && entryHigh >= pos.recentHigh;
  const hitStop = entryLow <= pos.stopPrice;

  const highFirst = Math.abs(entryOpen - entryHigh) < Math.abs(entryOpen - entryLow);

  if (!highFirst && hitStop) {
    const exitP = pos.stopPrice;
    const proceeds = pos.shares * exitP;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cash += proceeds;
    trades.push(createTradeRecord(pos, ts, exitP, pos.shares, pnl, pos.stopReason, 0, false));
    return [cash, trades, true];
  }

  if (hitProfit) {
    const halfShares = pos.shares * config.partialProfitRatio;
    const sellPrice = pos.recentHigh;
    const proceedsHalf = halfShares * sellPrice;
    const pnlHalf = proceedsHalf - halfShares * pos.entryPrice;
    cash += proceedsHalf;
    trades.push(createTradeRecord(pos, ts, sellPrice, halfShares, pnlHalf, '阶段止盈', 0, true));
    pos.shares -= halfShares;
    pos.halfSold = true;
    pos.halfSellPrice = sellPrice;
    pos.halfSellTime = ts;
  }

  if (hitStop) {
    const exitP = pos.stopPrice;
    const proceeds = pos.shares * exitP;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cash += proceeds;
    trades.push(createTradeRecord(pos, ts, exitP, pos.shares, pnl, pos.stopReason, 0, false));
    return [cash, trades, true];
  }

  // ①' 阶段止盈后止损调节
  if (hitProfit) {
    pos.maxClose = Math.max(pos.maxClose, close);
    let newStop = (pos.entryPrice + pos.maxClose) / 2;
    newStop = Math.max(pos.stopPrice, newStop);
    pos.stopPrice = newStop;
    pos.stopReason = '阶段止盈后止损';
    if (close < newStop) {
      const proceeds = pos.shares * close;
      const pnl = proceeds - pos.shares * pos.entryPrice;
      cash += proceeds;
      trades.push(createTradeRecord(pos, ts, close, pos.shares, pnl, '阶段止盈后收盘止损', 0, false));
      return [cash, trades, true];
    }
  }

  pos.maxClose = Math.max(pos.maxClose, close);

  if (!pos.brokeMa5 && close > ma5Cur) {
    pos.brokeMa5 = true;
  }

  if (close < ma5Cur && ma5Cur <= ma5Prev && pos.brokeMa5) {
    const proceeds = pos.shares * close;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cash += proceeds;
    trades.push(createTradeRecord(pos, ts, close, pos.shares, pnl, 'MA5下跌破线', 0, false));
    return [cash, trades, true];
  }

  if (!pos.ma5StopAdjusted && ma5Cur > ma5Prev) {
    let newStop = (pos.entryPrice + pos.maxClose) / 2;
    newStop = Math.max(pos.stopPrice, newStop);
    if (close < newStop) {
      const proceeds = pos.shares * close;
      const pnl = proceeds - pos.shares * pos.entryPrice;
      cash += proceeds;
      trades.push(createTradeRecord(pos, ts, close, pos.shares, pnl, 'MA5上升后止损', 0, false));
      return [cash, trades, true];
    } else {
      if (newStop > pos.stopPrice) pos.stopReason = 'MA5首次上升止损';
      pos.stopPrice = newStop;
      pos.ma5StopAdjusted = true;
    }
  }

  // 分批止盈
  const [tpCash, tpTrades, tpExited] = processTakeProfitTargets(pos, ts, close, config);
  cash += tpCash;
  trades.push(...tpTrades);
  if (tpExited) {
    return [cash, trades, true];
  }

  // 移动止盈
  const [trpCash, trpTrades, trpExited] = processTrailingProfit(pos, ts, close, config);
  cash += trpCash;
  trades.push(...trpTrades);
  if (trpExited) {
    return [cash, trades, true];
  }

  // 更新止损价
  updateStopAfterClose(pos, close, config);

  return [cash, trades, false];
}
