import { RegimeBacktestTrade } from './regime-backtest.types';
import { RankedCandidate } from './types/backtest-data.types';

/**
 * 引擎 trades 按 (signalDate, tsCode) 覆写 rank 三列；
 * 追加 rank≥2 的 not_top1 审计行（禁止把 rank=1 再写成 not_top1）。
 */
export function mergeRankAudit(
  engineTrades: RegimeBacktestTrade[],
  rankedAll: RankedCandidate[],
): { trades: RegimeBacktestTrade[]; extraSkipped: number } {
  const byKey = new Map(
    rankedAll.map((c) => [`${c.signalDate}|${c.tsCode}`, c]),
  );

  const enriched = engineTrades.map((t) => {
    const c = byKey.get(`${t.signalDate}|${t.tsCode}`);
    if (!c) return t;
    return {
      ...t,
      rank: c.rank,
      rankField: c.rankField,
      rankValue: c.rankValue,
    };
  });

  const notTop1: RegimeBacktestTrade[] = rankedAll
    .filter((c) => c.rank >= 2)
    .map((c) => ({
      signalDate: c.signalDate,
      buyDate: c.buyDate,
      exitDate: null,
      tsCode: c.tsCode,
      regime: c.regime,
      exitMode: c.exitMode,
      status: 'skipped' as const,
      skipReason: 'not_top1' as const,
      rank: c.rank,
      rankField: c.rankField,
      rankValue: c.rankValue,
    }));

  return {
    trades: [...enriched, ...notTop1],
    extraSkipped: notTop1.length,
  };
}
