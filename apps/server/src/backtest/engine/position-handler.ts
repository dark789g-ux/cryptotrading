/**
 * 持仓处理器 — 精确翻译自 backtest/position_handler.py
 */

import { KlineBarRow, Position, TradeRecord } from './models';
import { createTradeRecord } from './trade-helper';
import { setCooldown } from './cooldown';

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
  enablePartialProfit: boolean,
): [string | null, number, TradeRecord[]] {
  const row = df[curIdx];
  const open = row.open;
  const high = row.high;
  const low = row.low;
  const close = row.close;
  const ma5 = row.MA5;
  const time = String(row.open_time);

  const trades: TradeRecord[] = [];
  let cashDelta = 0;

  const prevMa5 = curIdx > 0 ? df[curIdx - 1].MA5 : ma5;

  // ──────────────────────────────────────────────────
  // 步骤 1+2：阶段止盈 与 止损
  // ──────────────────────────────────────────────────
  const hitProfit = enablePartialProfit && !pos.halfSold && high >= pos.recentHigh;
  const hitStop = low <= pos.stopPrice;

  if (hitProfit) {
    const halfShares = pos.shares / 2;
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

  // 规则 A：首次 close > MA5 → 设置突破标记
  if (!pos.brokeMa5 && close > ma5) {
    pos.brokeMa5 = true;
  }

  // 规则 B：MA5 下跌破线出场
  if (close < ma5 && ma5 <= prevMa5 && pos.brokeMa5) {
    const proceeds = pos.shares * close;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cashDelta += proceeds;
    trades.push(createTradeRecord(pos, time, close, pos.shares, pnl, 'MA5下跌破线', pos.candleCount, false));
    return ['exit_full', cashDelta, trades];
  }

  // 规则 C：MA5 首次上升 → 调节动态止损
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
      if (newStop > pos.stopPrice) {
        pos.stopReason = 'MA5首次上升止损';
      }
      pos.stopPrice = newStop;
      pos.ma5StopAdjusted = true;
    }
  }

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
  cooldownUntil: Map<string, string>,
  enablePartialProfit: boolean,
  cooldownHours: number,
): [number, TradeRecord[], boolean] {
  const trades: TradeRecord[] = [];
  const entryLow = df[curIdx].low;
  const entryHigh = df[curIdx].high;

  const hitProfit = enablePartialProfit && !pos.halfSold && entryHigh >= pos.recentHigh;
  const hitStop = entryLow <= pos.stopPrice;

  if (hitProfit) {
    const halfShares = pos.shares / 2;
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
    setCooldown(cooldownUntil, pos.symbol, ts, cooldownHours);
    return [cash, trades, true];
  }

  const close = df[curIdx].close;
  const ma5Cur = df[curIdx].MA5;
  const ma5Prev = curIdx > 0 ? df[curIdx - 1].MA5 : ma5Cur;

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
      setCooldown(cooldownUntil, pos.symbol, ts, cooldownHours);
      return [cash, trades, true];
    }
  }

  // ② MA5 收盘规则
  pos.maxClose = Math.max(pos.maxClose, close);

  // 规则 A
  if (!pos.brokeMa5 && close > ma5Cur) {
    pos.brokeMa5 = true;
  }

  // 规则 B：MA5 下跌破线出场
  if (close < ma5Cur && ma5Cur <= ma5Prev && pos.brokeMa5) {
    const proceeds = pos.shares * close;
    const pnl = proceeds - pos.shares * pos.entryPrice;
    cash += proceeds;
    trades.push(createTradeRecord(pos, ts, close, pos.shares, pnl, 'MA5下跌破线', 0, false));
    setCooldown(cooldownUntil, pos.symbol, ts, cooldownHours);
    return [cash, trades, true];
  }

  // 规则 C：MA5 首次上升 → 调节动态止损
  if (!pos.ma5StopAdjusted && ma5Cur > ma5Prev) {
    let newStop = (pos.entryPrice + pos.maxClose) / 2;
    newStop = Math.max(pos.stopPrice, newStop);
    if (close < newStop) {
      const proceeds = pos.shares * close;
      const pnl = proceeds - pos.shares * pos.entryPrice;
      cash += proceeds;
      trades.push(createTradeRecord(pos, ts, close, pos.shares, pnl, 'MA5上升后止损', 0, false));
      setCooldown(cooldownUntil, pos.symbol, ts, cooldownHours);
      return [cash, trades, true];
    } else {
      if (newStop > pos.stopPrice) {
        pos.stopReason = 'MA5首次上升止损';
      }
      pos.stopPrice = newStop;
      pos.ma5StopAdjusted = true;
    }
  }

  return [cash, trades, false];
}
