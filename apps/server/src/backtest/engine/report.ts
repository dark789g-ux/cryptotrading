/**
 * 回测报告生成 — 精确翻译自 backtest/report.py
 */

import { TradeRecord } from './models';

/** 不同 K 线周期下每年的 bar 数（用于 Sharpe 年化） */
const PERIODS_PER_YEAR: Record<string, number> = {
  '1m': 525600,
  '5m': 105120,
  '15m': 35040,
  '30m': 17520,
  '1h': 8760,
  '2h': 4380,
  '4h': 2190,
  '6h': 1460,
  '12h': 730,
  '1d': 365,
};

export interface BacktestStats {
  initialCapital: number;
  finalValue: number;
  totalReturnPct: number;
  totalPnl: number;
  maxDrawdownPct: number;
  sharpeAnnualized: number;
  fullTradeCount: number;
  halfTradeCount: number;
  winRate: number;
  avgWinReturnPct: number;
  avgLossReturnPct: number;
  avgHoldCandles: number;
  backtestBars: number;
  fullPositionBars: number;
  fullPositionPct: number;
}

export function calcStats(
  allTrades: TradeRecord[],
  portfolioLog: [string, number][],
  initialCapital: number,
  timeframe: string,
): BacktestStats {
  const pfValues = portfolioLog.map(([, v]) => v);
  const finalValue = pfValues[pfValues.length - 1] ?? initialCapital;
  const totalReturnPct = ((finalValue - initialCapital) / initialCapital) * 100;

  let peak = pfValues[0] ?? initialCapital;
  let maxDrawdownPct = 0;
  for (const v of pfValues) {
    if (v > peak) peak = v;
    const dd = peak ? ((peak - v) / peak) * 100 : 0;
    if (dd > maxDrawdownPct) maxDrawdownPct = dd;
  }

  let sharpe = 0;
  if (pfValues.length > 1) {
    const hourlyRets = pfValues.slice(1).map((v, i) => (v - pfValues[i]) / pfValues[i]);
    const meanR = hourlyRets.reduce((a, b) => a + b, 0) / hourlyRets.length;
    const variance = hourlyRets.reduce((a, r) => a + (r - meanR) ** 2, 0) / hourlyRets.length;
    const stdR = Math.sqrt(variance);
    const periodsPerYear = PERIODS_PER_YEAR[timeframe] ?? 8760;
    sharpe = stdR > 1e-12 ? (meanR / stdR) * Math.sqrt(periodsPerYear) : 0;
  }

  const fullTrades = allTrades.filter((t) => !t.isHalf);
  const halfTrades = allTrades.filter((t) => t.isHalf);
  const winningFull = fullTrades.filter((t) => t.pnl > 0);
  const losingFull = fullTrades.filter((t) => t.pnl < 0);
  const winRate = fullTrades.length ? (winningFull.length / fullTrades.length) * 100 : 0;
  const avgWinReturn = winningFull.length
    ? winningFull.reduce((a, t) => a + t.returnPct, 0) / winningFull.length : 0;
  const avgLossReturn = losingFull.length
    ? losingFull.reduce((a, t) => a + t.returnPct, 0) / losingFull.length : 0;
  const avgHold = fullTrades.length
    ? fullTrades.reduce((a, t) => a + t.holdCandles, 0) / fullTrades.length : 0;
  const totalPnl = allTrades.reduce((a, t) => a + t.pnl, 0);

  return {
    initialCapital,
    finalValue,
    totalReturnPct,
    totalPnl,
    maxDrawdownPct,
    sharpeAnnualized: sharpe,
    fullTradeCount: fullTrades.length,
    halfTradeCount: halfTrades.length,
    winRate,
    avgWinReturnPct: avgWinReturn,
    avgLossReturnPct: avgLossReturn,
    avgHoldCandles: avgHold,
    backtestBars: portfolioLog.length,
    fullPositionBars: 0,
    fullPositionPct: 0,
  };
}

// ──────────────────────────────────────────────────────────
// 报告数据构建（供前端消费）
// ──────────────────────────────────────────────────────────

function buildPositions(allTrades: TradeRecord[]): object[] {
  const posDict = new Map<string, TradeRecord[]>();
  for (const t of allTrades) {
    const key = `${t.symbol}|${t.entryTime}`;
    if (!posDict.has(key)) posDict.set(key, []);
    posDict.get(key)!.push(t);
  }

  const posList: object[] = [];
  for (const [, trades] of posDict) {
    const totalShares = trades.reduce((a, t) => a + t.shares, 0);
    const entryPrice = trades[0].entryPrice;
    const buyAmount = entryPrice * totalShares;
    const totalSell = trades.reduce((a, t) => a + t.exitPrice * t.shares, 0);
    const avgSell = totalShares ? totalSell / totalShares : 0;
    const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
    const closeTime = trades.reduce((a, t) => (t.exitTime > a ? t.exitTime : a), '');
    const holdCandles = trades.reduce((a, t) => Math.max(a, t.holdCandles), 0);
    const sortedTrades = [...trades].sort((a, b) => a.exitTime.localeCompare(b.exitTime));
    const stopTypes = [...new Set(sortedTrades.map((t) => t.exitReason))];

    const lastFullTrade = [...trades].reverse().find((t) => !t.isHalf);
    posList.push({
      symbol: trades[0].symbol,
      entryTime: trades[0].entryTime,
      entryPrice: entryPrice.toPrecision(6),
      buyAmount: Math.round(buyAmount * 100) / 100,
      buyShares: Math.round(totalShares * 1e6) / 1e6,
      closeTime,
      sellPrice: avgSell.toPrecision(6),
      sellAmount: Math.round(totalSell * 100) / 100,
      pnl: Math.round(totalPnl * 1e4) / 1e4,
      returnPct: buyAmount ? Math.round((totalPnl / buyAmount) * 100 * 1e4) / 1e4 : 0,
      holdCandles,
      tradeCount: trades.length,
      stopTypes,
      isSimulation: trades[0].isSimulation ?? false,
      overallReturnPct: lastFullTrade ? (lastFullTrade.overallReturnPct ?? 0) : 0,
      cumulativeWinRate: lastFullTrade ? (lastFullTrade.cumulativeWinRate ?? 0) : 0,
      cumulativeOdds: lastFullTrade ? (lastFullTrade.cumulativeOdds ?? 0) : 0,
      windowWinRate: lastFullTrade ? (lastFullTrade.windowWinRate ?? 0) : 0,
      windowOdds: lastFullTrade ? (lastFullTrade.windowOdds ?? 0) : 0,
    });
  }

  posList.sort((a: any, b: any) => a.entryTime.localeCompare(b.entryTime));
  const total = posList.length;
  for (let i = 0; i < posList.length; i++) {
    (posList[i] as any).posNo = total - i;
  }
  return posList;
}

function buildSymbols(allTrades: TradeRecord[]): object[] {
  const posDict = new Map<string, TradeRecord[]>();
  for (const t of allTrades) {
    const key = `${t.symbol}|${t.entryTime}`;
    if (!posDict.has(key)) posDict.set(key, []);
    posDict.get(key)!.push(t);
  }

  const posSummary: Array<{
    symbol: string; entryTime: string; buyAmount: number;
    pnl: number; returnPct: number; holdCandles: number; hadHalf: boolean;
  }> = [];

  for (const [, trades] of posDict) {
    const totalShares = trades.reduce((a, t) => a + t.shares, 0);
    const entryPrice = trades[0].entryPrice;
    const buyAmount = entryPrice * totalShares;
    const totalPnl = trades.reduce((a, t) => a + t.pnl, 0);
    const returnPct = buyAmount ? (totalPnl / buyAmount) * 100 : 0;
    const holdCandles = trades.reduce((a, t) => Math.max(a, t.holdCandles), 0);
    const hadHalf = trades.some((t) => t.isHalf);
    posSummary.push({ symbol: trades[0].symbol, entryTime: trades[0].entryTime, buyAmount, pnl: totalPnl, returnPct, holdCandles, hadHalf });
  }

  const symDict = new Map<string, typeof posSummary>();
  for (const p of posSummary) {
    if (!symDict.has(p.symbol)) symDict.set(p.symbol, []);
    symDict.get(p.symbol)!.push(p);
  }

  const symList: object[] = [];
  for (const [symbol, positions] of symDict) {
    const posCount = positions.length;
    const winCount = positions.filter((p) => p.pnl > 0).length;
    const winRate = posCount ? (winCount / posCount) * 100 : 0;
    const totalPnl = positions.reduce((a, p) => a + p.pnl, 0);
    const totalBuy = positions.reduce((a, p) => a + p.buyAmount, 0);
    const returns = positions.map((p) => p.returnPct);
    const avgReturn = returns.length ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const bestReturn = returns.length ? Math.max(...returns) : 0;
    const worstReturn = returns.length ? Math.min(...returns) : 0;
    const avgHold = posCount ? positions.reduce((a, p) => a + p.holdCandles, 0) / posCount : 0;
    const halfCount = positions.filter((p) => p.hadHalf).length;
    const entryTimes = positions.map((p) => p.entryTime);
    symList.push({
      symbol,
      posCount,
      winRate: Math.round(winRate * 10) / 10,
      totalPnl: Math.round(totalPnl * 100) / 100,
      totalBuy: Math.round(totalBuy * 100) / 100,
      avgReturn: Math.round(avgReturn * 100) / 100,
      bestReturn: Math.round(bestReturn * 100) / 100,
      worstReturn: Math.round(worstReturn * 100) / 100,
      avgHold: Math.round(avgHold * 10) / 10,
      halfCount,
      firstEntry: entryTimes.reduce((a, b) => (a < b ? a : b), entryTimes[0]),
      lastEntry: entryTimes.reduce((a, b) => (a > b ? a : b), entryTimes[0]),
    });
  }

  symList.sort((a: any, b: any) => b.totalPnl - a.totalPnl);
  return symList;
}

function buildTransactions(allTrades: TradeRecord[]): object[] {
  const buyAgg = new Map<string, { entryPrice: number; shares: number; entryReason: string }>();
  for (const t of allTrades) {
    const key = `${t.symbol}|${t.entryTime}`;
    if (!buyAgg.has(key)) {
      buyAgg.set(key, { entryPrice: t.entryPrice, shares: 0, entryReason: t.entryReason });
    }
    if (!t.isHalf) {
      buyAgg.get(key)!.shares += t.shares;
    }
  }

  const txnList: Array<{
    time: string; symbol: string; price: string; amount: number;
    shares: number; direction: string; reason: string;
  }> = [];

  for (const [key, agg] of buyAgg) {
    const [symbol, entryTime] = key.split('|');
    txnList.push({
      time: entryTime,
      symbol,
      price: agg.entryPrice.toPrecision(6),
      amount: Math.round(agg.entryPrice * agg.shares * 100) / 100,
      shares: Math.round(agg.shares * 1e6) / 1e6,
      direction: '买入',
      reason: agg.entryReason,
    });
  }
  for (const t of allTrades) {
    txnList.push({
      time: t.exitTime,
      symbol: t.symbol,
      price: t.exitPrice.toPrecision(6),
      amount: Math.round(t.exitPrice * t.shares * 100) / 100,
      shares: Math.round(t.shares * 1e6) / 1e6,
      direction: '卖出',
      reason: t.exitReason,
    });
  }

  txnList.sort((a, b) => a.time.localeCompare(b.time));
  const total = txnList.length;
  return txnList.reverse().map((x, i) => ({ txnNo: total - i, ...x }));
}

export function prepareReportData(
  allTrades: TradeRecord[],
  portfolioLog: [string, number][],
  stats: BacktestStats,
  maxPositions: number,
  posSnapshots?: Array<Array<{ symbol: string; entryTime: string; holdH: number; pnlPct: number }>>,
): object {
  const totalBars = portfolioLog.length;
  const fullBars = posSnapshots
    ? posSnapshots.filter((s) => s.length >= maxPositions).length
    : 0;
  const fullPositionPct = totalBars ? (fullBars / totalBars) * 100 : 0;
  stats = { ...stats, fullPositionBars: fullBars, fullPositionPct };

  const sampleStep = Math.max(1, Math.floor(portfolioLog.length / 1000));
  const sampledLog = portfolioLog.filter((_, i) => i % sampleStep === 0);
  const sampledSnapshots = posSnapshots
    ? posSnapshots.filter((_, i) => i % sampleStep === 0)
    : sampledLog.map(() => []);

  // monthly returns —— 首月基准用 initialCapital，末月循环结束后补 flush
  const monthly: Map<string, number[]> = new Map();
  if (portfolioLog.length) {
    let baseVal = stats.initialCapital;
    let curMonth = portfolioLog[0][0].slice(0, 7);
    let lastVal = baseVal;
    for (const [ts, val] of portfolioLog) {
      const month = ts.slice(0, 7);
      if (month !== curMonth) {
        const ret = baseVal ? ((lastVal - baseVal) / baseVal) * 100 : 0;
        if (!monthly.has(curMonth)) monthly.set(curMonth, []);
        monthly.get(curMonth)!.push(ret);
        baseVal = lastVal;
        curMonth = month;
      }
      lastVal = val;
    }
    const retFinal = baseVal ? ((lastVal - baseVal) / baseVal) * 100 : 0;
    if (!monthly.has(curMonth)) monthly.set(curMonth, []);
    monthly.get(curMonth)!.push(retFinal);
  }

  const pnlBySym = new Map<string, number>();
  for (const t of allTrades) {
    pnlBySym.set(t.symbol, (pnlBySym.get(t.symbol) ?? 0) + t.pnl);
  }
  const topSyms = [...pnlBySym.entries()].sort((a, b) => b[1] - a[1]).slice(0, 15);

  const totalPositions = new Set(allTrades.map((t) => `${t.symbol}|${t.entryTime}`)).size;

  return {
    stats,
    portfolio: {
      labels: sampledLog.map(([t]) => t),
      values: sampledLog.map(([, v]) => Math.round(v * 100) / 100),
      snapshots: sampledSnapshots,
    },
    monthly: {
      labels: [...monthly.keys()],
      values: [...monthly.values()].map((v) => Math.round((v.reduce((a, b) => a + b, 0) / v.length) * 100) / 100),
    },
    symbolsPnl: {
      labels: topSyms.map(([s]) => s),
      values: topSyms.map(([, p]) => Math.round(p * 100) / 100),
    },
    positions: buildPositions(allTrades),
    totalPositions,
    totalTrades: allTrades.length,
    transactions: buildTransactions(allTrades),
    symbols: buildSymbols(allTrades),
  };
}
