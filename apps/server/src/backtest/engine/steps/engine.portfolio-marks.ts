import type { KlineBarRow, Position } from '../models';

/**
 * 计算当前持仓市值与快照
 */
export function calculatePortfolioValue(
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
export function calculateOpenEquity(
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
