import { calcSignalStats } from './metrics';

export const TRADING_DAYS_PER_YEAR = 244;

export interface EngineDailyRow {
  tradeDate: string;
  nav: number;
  cash: number;
  dailyRet: number;
  positionCount: number;
  exposure: number;
}

export interface EngineSummary {
  finalNav: number;
  totalRet: number;
  annualRet: number | null;
  maxDrawdown: number;
  sharpe: number | null;
  calmar: number | null;
  dailyWinRate: number | null;
  dailyKelly: number | null;
  nTaken: number;
  nSkipped: number;
  totalCosts: number;
}

export function computeSummary(
  dailyRows: EngineDailyRow[],
  nTaken: number,
  nSkipped: number,
  initialCapital: number,
  totalCosts: number,
): EngineSummary {
  const nDays = dailyRows.length;
  const finalNav = nDays > 0 ? dailyRows[nDays - 1].nav : initialCapital;
  const totalRet = finalNav / initialCapital - 1;

  let annualRet: number | null = null;
  if (finalNav > 0 && nDays > 0) {
    annualRet = Math.pow(1 + totalRet, TRADING_DAYS_PER_YEAR / nDays) - 1;
  }

  let peak = -Infinity;
  let maxDrawdown = 0;
  for (const row of dailyRows) {
    if (row.nav > peak) peak = row.nav;
    if (peak > 0) {
      const dd = row.nav / peak - 1;
      if (dd < maxDrawdown) maxDrawdown = dd;
    }
  }

  const dailyRets = dailyRows.map((r) => r.dailyRet);
  let sharpe: number | null = null;
  if (dailyRets.length >= 2) {
    const mean = dailyRets.reduce((a, b) => a + b, 0) / dailyRets.length;
    const variance =
      dailyRets.reduce((a, b) => a + (b - mean) * (b - mean), 0) /
      (dailyRets.length - 1);
    const std = Math.sqrt(variance);
    if (std > 0) {
      sharpe = (mean / std) * Math.sqrt(TRADING_DAYS_PER_YEAR);
    }
  }

  const calmar =
    annualRet !== null && maxDrawdown < 0
      ? annualRet / Math.abs(maxDrawdown)
      : null;

  const stats = calcSignalStats(dailyRets, dailyRets.map(() => 1));

  return {
    finalNav,
    totalRet,
    annualRet,
    maxDrawdown,
    sharpe,
    calmar,
    dailyWinRate: stats.winRate,
    dailyKelly: stats.kellyF,
    nTaken,
    nSkipped,
    totalCosts,
  };
}
