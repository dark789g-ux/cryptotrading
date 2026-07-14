/**
 * 交易辅助函数 — 精确翻译自 backtest/trade_helper.py
 */

import { Position, TradeRecord, BacktestConfig } from './models';

/**
 * 封装卖出结算：计算 grossProceeds、exitFee、netProceeds、pnl，含 entryFee 按比例分摊。
 * 同时缩减 pos.entryFee 以反映已卖出的 entryFee 部分，使后续卖出时剩余 entryFee 与剩余 shares 一致。
 */
export function settleSell(
  pos: Position, exitPrice: number, sharesSold: number, config: BacktestConfig,
): { netProceeds: number; exitFee: number; entryFeePortion: number; pnl: number } {
  const grossProceeds = sharesSold * exitPrice;
  const exitFee = grossProceeds * config.feeRate;
  const netProceeds = grossProceeds - exitFee;
  const costPortion = sharesSold * pos.entryPrice;
  const entryFeePortion = pos.entryFee * (sharesSold / pos.shares);
  const pnl = netProceeds - costPortion - entryFeePortion;
  // 缩减 pos.entryFee，使后续卖出时剩余 entryFee 与剩余 shares 一致
  pos.entryFee -= entryFeePortion;
  return { netProceeds, exitFee, entryFeePortion, pnl };
}

export function createTradeRecord(
  pos: Position,
  exitTime: string,
  exitPrice: number,
  shares: number,
  pnl: number,
  exitReason: string,
  holdCandles: number,
  isHalf = false,
  entryFee = 0,
  exitFee = 0,
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
    tradePhase: 'live',
    overallReturnPct: 0,
    cumulativeWinRate: 0,
    cumulativeOdds: 0,
    windowWinRate: 0,
    windowOdds: 0,
    entryFee,
    exitFee,
  };
}
