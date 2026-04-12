/**
 * 信号扫描器 — 精确翻译自 backtest/signal_scanner.py
 */

import { KlineBarRow, BacktestConfig } from './models';
import { calcRecentLow, calcRecentHigh } from './bt-indicators';

/**
 * 扫描当前时间步收盘后的入场信号。
 * 条件：close > MA60 AND MA30 > MA60 AND MA60 > MA120 AND close > MA240
 *       AND KDJ.K < kdjKMax AND KDJ.D < kdjDMax AND KDJ.J < kdjJMax
 *       AND 1 - (recentLow/close) < maxInitLoss
 *       AND rrRatio > minRiskRewardRatio
 *
 * 返回按盈亏比降序排列的 [symbol, rrRatio] 列表。
 */
export function scanSignals(
  data: Map<string, KlineBarRow[]>,
  ts: string,
  tsToIdx: Map<string, Map<string, number>>,
  heldSymbols: Set<string>,
  cooldownUntil: Map<string, string>,
  config: BacktestConfig,
): [string, number][] {
  const candidates: [string, number][] = [];

  for (const [symbol, df] of data) {
    if (heldSymbols.has(symbol)) continue;

    const coolUntil = cooldownUntil.get(symbol) ?? '';
    if (coolUntil && ts < coolUntil) continue;

    const idxMap = tsToIdx.get(symbol);
    if (!idxMap) continue;
    const idx = idxMap.get(ts);
    if (idx === undefined) continue;

    const row = df[idx];
    const close = row.close;
    const ma30 = row.MA30;
    const ma60 = row.MA60;
    const ma120 = row.MA120;
    const ma240 = row.MA240;
    const kdjK = row['KDJ.K'];
    const kdjD = row['KDJ.D'];
    const kdjJ = row['KDJ.J'];

    if (!(close > ma60 && ma30 > ma60 && ma60 > ma120 && close > ma240)) continue;
    if (!(kdjK < config.kdjKMax && kdjD < config.kdjDMax && kdjJ < config.kdjJMax)) continue;

    // 入场条件通过后才计算近期低点
    const [recentLow] = calcRecentLow(df, idx + 1, config.lookbackBuffer);

    const initLoss = 1 - recentLow / close;
    if (initLoss >= config.maxInitLoss) continue;

    const buyPrice = close;
    const [recentHigh] = calcRecentHigh(df, idx + 1, config.lookbackBuffer);
    const risk = buyPrice - recentLow;
    const reward = recentHigh - buyPrice;
    const rrRatio = risk > 0 ? reward / risk : 0;

    if (rrRatio <= config.minRiskRewardRatio) continue;

    candidates.push([symbol, rrRatio]);
  }

  candidates.sort((a, b) => b[1] - a[1]);
  return candidates;
}
