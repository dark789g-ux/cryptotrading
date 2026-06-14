/**
 * portfolio-sim.ranking.ts
 *
 * 引擎排序段（纯函数，不依赖 DB / NestJS）。spec 03 §rankAndScore 契约。
 *
 * 把排序统一收敛到 rankSpec（resolveRankSpec 适配 legacy）：
 *   - none（factors 空）  → 按 ts_code 升序；scoreByTrade 全 null；qualityByTrade 全 0.5。
 *   - 单因子（len1）      → 退化路径，逐位等价现 sortCandidates（有值排前、按 dir、平局 ts_code、null 殿后）。
 *   - composite（len>1）  → sortByRankingScore 移植（spec 03 §确定性版：同值/同 null 并列同分）。
 *
 * 质量分位 qualityByTrade 基于最终 sorted 名次（钉死公式，spec 03 §质量分位）：
 *   q = (n>1) ? (n-1-rankIndex)/(n-1) : 1.0；none → 全 0.5。
 */

import { resolveRankSpec } from './portfolio-sim.factor-registry';
import {
  EngineTrade,
  PortfolioSimSource,
  RankFactor,
  RankFactorKey,
} from './portfolio-sim.types';

/** rankAndScore 输出。 */
export interface RankAndScoreResult {
  /** 已排序候选（开仓遍历顺序；最优在前）。 */
  sorted: EngineTrade[];
  /** 综合分（composite）/ 单因子值（single）/ null（none）。 */
  scoreByTrade: Map<EngineTrade, number | null>;
  /** 日内质量分位 ∈[0,1]，1=最优（供 signal_weighted sizing）。 */
  qualityByTrade: Map<EngineTrade, number>;
}

/** ts_code 升序比较（确定性二级键）。 */
function tsCodeAsc(a: EngineTrade, b: EngineTrade): number {
  return a.tsCode < b.tsCode ? -1 : a.tsCode > b.tsCode ? 1 : 0;
}

/** 取候选在某因子上的值（缺失为 null）。 */
function factorValue(trade: EngineTrade, factor: RankFactorKey): number | null {
  const v = trade.factorValues?.[factor];
  return v == null ? null : v;
}

/**
 * 按最终 sorted 名次填充 qualityByTrade（spec 03 §质量分位，钉死公式）。
 *   q = (n>1) ? (n-1-rankIndex)/(n-1) : 1.0
 */
function fillQuality(
  sorted: EngineTrade[],
  qualityByTrade: Map<EngineTrade, number>,
): void {
  const n = sorted.length;
  sorted.forEach((trade, rankIndex) => {
    const q = n > 1 ? (n - 1 - rankIndex) / (n - 1) : 1.0;
    qualityByTrade.set(trade, q);
  });
}

/**
 * 单因子取值（含 legacy 兼容桥）。
 *
 * 新 loader 路径：trade.factorValues[factor] 已装载（含 null=缺值），直接用。
 * legacy 路径：trade.factorValues 整体缺失（旧 run 重放 / 旧测试只设 rankValue）→ 该因子的
 *   值回落到 trade.rankValue。这样单因子退化逐位等价现 sortCandidates（读 rankValue），零漂移。
 *
 * 仅「factorValues 整体未装载」或「该 key 未装载」才回落 rankValue；已装载为 null 不回落
 * （新 loader 统一 rankValue=null，回落无意义且语义应保持「该因子缺值」）。
 */
function singleFactorValue(trade: EngineTrade, factor: RankFactorKey): number | null {
  const fv = trade.factorValues?.[factor];
  if (fv !== undefined) return fv; // 已装载（含显式 null）
  return trade.rankValue; // legacy 桥：factorValues 未装载 → rankValue
}

/**
 * 单因子退化（spec 03 §单因子退化，等价现 sortCandidates）。
 *   有值排前、按 dir（asc/desc）、平局 ts_code 升序、null 殿后。
 *   scoreByTrade = 该因子值（null 保留 null）。
 */
function rankSingleFactor(
  trades: EngineTrade[],
  factor: RankFactor,
): { sorted: EngineTrade[]; scoreByTrade: Map<EngineTrade, number | null> } {
  const scoreByTrade = new Map<EngineTrade, number | null>();
  for (const t of trades) scoreByTrade.set(t, singleFactorValue(t, factor.factor));

  const sorted = [...trades].sort((a, b) => {
    const va = scoreByTrade.get(a)!;
    const vb = scoreByTrade.get(b)!;
    const aHas = va !== null;
    const bHas = vb !== null;
    // 有值项整体排在缺失（null）项之前。
    if (aHas !== bHas) return aHas ? -1 : 1;
    if (aHas && bHas) {
      const cmp =
        factor.dir === 'asc' ? (va as number) - (vb as number) : (vb as number) - (va as number);
      if (cmp !== 0) return cmp;
    }
    // 平局 / 同为缺失：ts_code 升序。
    return tsCodeAsc(a, b);
  });
  return { sorted, scoreByTrade };
}

/**
 * composite 多因子加权（spec 03 §composite，确定性版）。
 *
 * 对每个因子：有值者按 (dir, 再 ts_code asc) 排，null 者全部并列殿后；
 *   计分用「组首名次」(n − groupStartRank)，同值（含全部 null）并列同分（不按数组位置递减）；
 *   null 组并列最低档 (n − valuedCount)。
 * 综合分 = Σ(因子分 × weight) / totalWeight，降序、平局 ts_code 升序。
 */
function rankComposite(
  trades: EngineTrade[],
  factors: RankFactor[],
): { sorted: EngineTrade[]; scoreByTrade: Map<EngineTrade, number | null> } {
  const n = trades.length;
  const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);

  // totalWeight<=0：退化为 ts_code 序，score 全 null（spec 03 line73）。
  if (totalWeight <= 0) {
    const sorted = [...trades].sort(tsCodeAsc);
    const scoreByTrade = new Map<EngineTrade, number | null>();
    for (const t of trades) scoreByTrade.set(t, null);
    return { sorted, scoreByTrade };
  }

  // 累积原始加权分（未归一）。
  const rawScore = new Map<EngineTrade, number>();
  for (const t of trades) rawScore.set(t, 0);

  for (const f of factors) {
    const valued = trades
      .filter((c) => factorValue(c, f.factor) !== null)
      .sort((a, b) => {
        const va = factorValue(a, f.factor) as number;
        const vb = factorValue(b, f.factor) as number;
        const cmp = f.dir === 'asc' ? va - vb : vb - va;
        return cmp !== 0 ? cmp : tsCodeAsc(a, b);
      });
    const nullish = trades.filter((c) => factorValue(c, f.factor) === null);
    const valuedCount = valued.length;

    // 组首名次计分：相同因子值的连续段视为一组，组内同赋 (n − groupStartRank)。
    let i = 0;
    while (i < valuedCount) {
      const groupStartRank = i; // 0-based 组首名次
      const groupVal = factorValue(valued[i], f.factor) as number;
      let j = i;
      while (j < valuedCount && (factorValue(valued[j], f.factor) as number) === groupVal) {
        j++;
      }
      const groupScore = n - groupStartRank;
      for (let k = i; k < j; k++) {
        rawScore.set(valued[k], (rawScore.get(valued[k]) as number) + groupScore * f.weight);
      }
      i = j;
    }

    // null 组并列最低档 (n − valuedCount)。
    const nullScore = (n - valuedCount) * f.weight;
    for (const c of nullish) {
      rawScore.set(c, (rawScore.get(c) as number) + nullScore);
    }
  }

  const sorted = [...trades].sort((a, b) => {
    const diff = (rawScore.get(b) as number) - (rawScore.get(a) as number);
    return diff !== 0 ? diff : tsCodeAsc(a, b);
  });

  const scoreByTrade = new Map<EngineTrade, number | null>();
  for (const t of trades) {
    scoreByTrade.set(t, (rawScore.get(t) as number) / totalWeight);
  }
  return { sorted, scoreByTrade };
}

/**
 * 排序并计分（spec 03 §rankAndScore 契约）。
 *
 * @param trades 当日同源候选集（横截面 = 当日该 source 的候选）
 * @param source 该 source 配置（经 resolveRankSpec 解析排序规格）
 */
export function rankAndScore(
  trades: EngineTrade[],
  source: PortfolioSimSource,
): RankAndScoreResult {
  const factors = resolveRankSpec(source);
  const qualityByTrade = new Map<EngineTrade, number>();

  // none：按 ts_code 升序、score 全 null、quality 全 0.5。
  if (factors.length === 0) {
    const sorted = [...trades].sort(tsCodeAsc);
    const scoreByTrade = new Map<EngineTrade, number | null>();
    for (const t of trades) {
      scoreByTrade.set(t, null);
      qualityByTrade.set(t, 0.5);
    }
    return { sorted, scoreByTrade, qualityByTrade };
  }

  const { sorted, scoreByTrade } =
    factors.length === 1
      ? rankSingleFactor(trades, factors[0])
      : rankComposite(trades, factors);

  fillQuality(sorted, qualityByTrade);
  return { sorted, scoreByTrade, qualityByTrade };
}
