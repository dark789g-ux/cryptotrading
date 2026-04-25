/**
 * 信号扫描器 — 精确翻译自 backtest/signal_scanner.py
 */

import { KlineBarRow, BacktestConfig, MaOperand, MaOperator, SortFactor } from './models';
import { calcRecentLow, calcRecentHigh, BrickBar } from './bt-indicators';

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

// ── 排序因子计算 ──

function calcMomentum(row: KlineBarRow, factor: SortFactor): number {
  const maPeriod = (factor.params?.maPeriod as number) ?? 5;
  const maKey = `MA${maPeriod}`;
  const ma = (row[maKey] as number) ?? 0;
  const atr = (row['atr_14'] as number) ?? 0;
  if (atr <= 0) return 0;
  return (row.close - ma) / atr;
}

function calcFreshness(df: KlineBarRow[], idx: number, config: BacktestConfig): number {
  const threshold = config.kdjJOversold;
  let bars = 0;
  for (let i = idx; i >= 0; i--) {
    const j = df[i]['KDJ.J'] as number;
    if (j >= threshold) break;
    bars++;
  }
  return 1 / (1 + bars);
}

function calcLiquidity(row: KlineBarRow): number {
  return (row['quote_volume'] as number) ?? 0;
}

function calcVolatility(row: KlineBarRow): number {
  const atr = (row['atr_14'] as number) ?? 0;
  if (atr <= 0) return 0;
  return row.close / atr;
}

function calcFactorValue(
  factor: SortFactor,
  row: KlineBarRow,
  df: KlineBarRow[],
  idx: number,
  config: BacktestConfig,
  rrRatio: number,
): number {
  switch (factor.factor) {
    case 'risk_reward': return rrRatio;
    case 'momentum': return calcMomentum(row, factor);
    case 'freshness': return calcFreshness(df, idx, config);
    case 'liquidity': return calcLiquidity(row);
    case 'volatility': return calcVolatility(row);
    default: return 0;
  }
}

interface CandidateData {
  symbol: string;
  rrRatio: number;
  values: Record<string, number>;
}

function sortByRankingScore(
  candidates: CandidateData[],
  factors: SortFactor[],
): CandidateData[] {
  const n = candidates.length;
  if (n <= 1) return candidates;

  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
  if (totalWeight <= 0) return candidates;

  const scores = new Map<string, number>();

  for (const factor of factors) {
    const sorted = [...candidates].sort((a, b) => {
      const va = a.values[factor.factor] ?? 0;
      const vb = b.values[factor.factor] ?? 0;
      if (va === vb) return 0;
      return factor.direction === 'desc' ? vb - va : va - vb;
    });

    sorted.forEach((c, rank) => {
      const score = n - rank;
      const current = scores.get(c.symbol) ?? 0;
      scores.set(c.symbol, current + score * factor.weight);
    });
  }

  return [...candidates].sort((a, b) => {
    const sa = (scores.get(a.symbol) ?? 0) / totalWeight;
    const sb = (scores.get(b.symbol) ?? 0) / totalWeight;
    return sb - sa;
  });
}

/**
 * 扫描当前时间步收盘后的入场信号。
 *
 * MA 条件：若 config.maConditions 非空，按动态列表逐条 AND 检查；
 *          否则回退到原始硬编码条件（close > MA60 AND MA30 > MA60 AND MA60 > MA120 AND close > MA240）。
 *
 * KDJ 条件：若 precomputedKdj 非空（自定义周期），取预计算值；否则使用行内预存 KDJ。
 *          J 取自当根或往前 kdjOversoldJOffset 根（0=当根）。
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
  brickMap?: Map<string, BrickBar[]>,
): [string, number][] {
  const candidates: CandidateData[] = [];
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
    const jIdx = idx - config.kdjOversoldJOffset;
    if (jIdx < 0 || jIdx >= df.length) continue;

    let kdjJ: number;
    const customKdj = precomputedKdj?.get(symbol);
    if (customKdj) {
      kdjJ = customKdj[jIdx].j;
    } else {
      kdjJ = df[jIdx]['KDJ.J'] as number;
    }

    // J 超卖阈值（入场信号区）
    if (config.kdjJOversold > 0 && kdjJ >= config.kdjJOversold) continue;

    const [recentLow] = calcRecentLow(df, idx + 1, config.recentLowWindow, config.recentLowBuffer);

    // ── 入场初始止损限制（随止损策略联动）──
    const distLimit = config.entryMaxDistFromLowPct > 0
      ? config.entryMaxDistFromLowPct / 100
      : config.maxInitLoss;
    let initLoss: number;
    if (config.stopLossMode === 'fixed') {
      initLoss = config.fixedStopLossPct / 100;
    } else if (config.stopLossMode === 'signal_midpoint') {
      const signalMidpoint = (row.open + close) / 2;
      initLoss = 1 - (signalMidpoint * config.stopLossFactor) / close;
    } else {
      // atr (default)
      initLoss = 1 - (recentLow * config.stopLossFactor) / close;
    }
    if (initLoss >= distLimit) continue;

    const buyPrice = close;
    const [recentHigh] = calcRecentHigh(df, idx + 1, config.recentHighWindow, config.recentHighBuffer);
    const risk = buyPrice - recentLow;
    const reward = recentHigh - buyPrice;
    const rrRatio = risk > 0 ? reward / risk : 0;

    if (rrRatio <= config.minRiskRewardRatio) continue;

    // ── 砖型图 XG 转折信号 ──
    if (config.brickXgEnabled && brickMap) {
      const bars = brickMap.get(symbol);
      if (!bars || idx < 2) continue;
      const aa = bars[idx].brick > bars[idx - 1].brick;
      const aaPrev = bars[idx - 1].brick > bars[idx - 2].brick;
      if (!(!aaPrev && aa)) continue;
      if (config.brickDeltaMin > 0 && bars[idx].delta < config.brickDeltaMin) continue;
    }

    const values: Record<string, number> = {};
    for (const f of config.entrySortFactors) {
      if (!f.enabled) continue;
      values[f.factor] = calcFactorValue(f, row, df, idx, config, rrRatio);
    }
    candidates.push({ symbol, rrRatio, values });
  }

  // ── 按配置排序 ──
  const activeFactors = config.entrySortFactors.filter((f) => f.enabled);
  if (activeFactors.length === 0) {
    return candidates.map((c) => [c.symbol, c.rrRatio] as [string, number]);
  }

  const sorted = sortByRankingScore(candidates, activeFactors);
  return sorted.map((c) => [c.symbol, c.rrRatio] as [string, number]);
}
