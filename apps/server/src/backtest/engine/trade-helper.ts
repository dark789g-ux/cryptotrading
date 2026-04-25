/**
 * 交易辅助函数 — 精确翻译自 backtest/trade_helper.py
 */

import { Position, TradeRecord } from './models';

export function createTradeRecord(
  pos: Position,
  exitTime: string,
  exitPrice: number,
  shares: number,
  pnl: number,
  exitReason: string,
  holdCandles: number,
  isHalf = false,
): TradeRecord {
  const costBasis = shares * pos.entryPrice;
  return {
    symbol: pos.symbol,
    entryTime: pos.entryTime,
    entryPrice: pos.entryPrice,
    exitTime,
    exitPrice,
    shares,
    pnl,
    returnPct: costBasis ? (pnl / costBasis) * 100 : 0,
    exitReason,
    holdCandles,
    isHalf,
    entryReason: pos.entryReason,
    isSimulation: false,
    overallReturnPct: 0,
    cumulativeWinRate: 0,
    cumulativeOdds: 0,
    windowWinRate: 0,
    windowOdds: 0,
  };
}
