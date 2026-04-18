/**
 * 信号扫描器 — 精确翻译自 backtest/signal_scanner.py
 */

import { KlineBarRow, BacktestConfig, MaOperand, MaOperator } from './models';
import { calcRecentLow, calcRecentHigh } from './bt-indicators';

function getMaOperandValue(row: KlineBarRow, key: MaOperand): number {
  if (key === 'close') return row.close;
  const maKey = key.replace('ma', 'MA'); // 'ma60' -> 'MA60'
  return (row[maKey] as number) ?? 0;
}

function evalMaOp(left: number, op: MaOperator, right: number): boolean {
  switch (op) {
    case '>':  return left > right;
    case '>=': return left >= right;
    case '<':  return left < right;
    case '<=': return left <= right;
    case '=':  return left === right;
    case '!=': return left !== right;
  }
}

/**
 * 扫描当前时间步收盘后的入场信号。
 *
 * MA 条件：若 config.maConditions 非空，按动态列表逐条 AND 检查；
 *          否则回退到原始硬编码条件（close > MA60 AND MA30 > MA60 AND MA60 > MA120 AND close > MA240）。
 *
 * KDJ 条件：若 precomputedKdj 非空（自定义周期），取预计算值；否则使用行内预存 KDJ。
 *
 * 入场距低点：若 config.entryMaxDistFromLowPct > 0，用该值（%）限制距低点距离；否则回退 config.maxInitLoss。
 *
 * 返回按盈亏比降序排列的 [symbol, rrRatio] 列表。
 */
export function scanSignals(
  data: Map<string, KlineBarRow[]>,
  ts: string,
  tsToIdx: Map<string, Map<string, number>>,
  heldSymbols: Set<string>,
  config: BacktestConfig,
  precomputedKdj?: Map<string, Array<{ k: number; d: number; j: number }>>,
): [string, number][] {
  const candidates: [string, number][] = [];
  const minWindow = Math.max(config.recentLowWindow, config.recentHighWindow);

  for (const [symbol, df] of data) {
    if (heldSymbols.has(symbol)) continue;

    const idxMap = tsToIdx.get(symbol);
    if (!idxMap) continue;
    const idx = idxMap.get(ts);
    if (idx === undefined) continue;

    // 账户级冷却由引擎主循环在调用 scanSignals 前判断，此处不再做 per-symbol 冷却过滤

    if (idx + 1 < minWindow) continue;

    const row = df[idx];
    const close = row.close;

    // ── MA 条件 ──
    if (config.maConditions && config.maConditions.length > 0) {
      let maPass = true;
      for (const cond of config.maConditions) {
        const left = getMaOperandValue(row, cond.left);
        const right = getMaOperandValue(row, cond.right);
        if (!evalMaOp(left, cond.op ?? '>', right)) { maPass = false; break; }
      }
      if (!maPass) continue;
    } else {
      const ma30 = row.MA30;
      const ma60 = row.MA60;
      const ma120 = row.MA120;
      const ma240 = row.MA240;
      if (!(close > ma60 && ma30 > ma60 && ma60 > ma120 && close > ma240)) continue;
    }

    // ── KDJ 条件 ──
    let kdjJ: number;
    const customKdj = precomputedKdj?.get(symbol);
    if (customKdj) {
      kdjJ = customKdj[idx].j;
    } else {
      kdjJ = row['KDJ.J'] as number;
    }

    // J 超卖阈值（入场信号区）
    if (config.kdjJOversold > 0 && kdjJ >= config.kdjJOversold) continue;

    const [recentLow] = calcRecentLow(df, idx + 1, config.recentLowWindow, config.recentLowBuffer);

    // ── 入场距低点限制 ──
    const distLimit = config.entryMaxDistFromLowPct > 0
      ? config.entryMaxDistFromLowPct / 100
      : config.maxInitLoss;
    const initLoss = 1 - recentLow / close;
    if (initLoss >= distLimit) continue;

    const buyPrice = close;
    const [recentHigh] = calcRecentHigh(df, idx + 1, config.recentHighWindow, config.recentHighBuffer);
    const risk = buyPrice - recentLow;
    const reward = recentHigh - buyPrice;
    const rrRatio = risk > 0 ? reward / risk : 0;

    if (rrRatio <= config.minRiskRewardRatio) continue;

    candidates.push([symbol, rrRatio]);
  }

  candidates.sort((a, b) => b[1] - a[1]);
  return candidates;
}
