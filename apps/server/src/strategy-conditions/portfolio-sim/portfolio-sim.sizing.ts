/**
 * portfolio-sim.sizing.ts
 *
 * 引擎仓位段（纯函数，不依赖 DB / NestJS）。spec 04 §computeAlloc 契约。
 *
 * 组合级 sizing：在 positionRatio 基线上乘一个 [0, cap] 乘子（不放大总杠杆，
 * 总敞口仍受 exposureCap/maxPositions/cash_short 卡死）。三模式：
 *   - fixed           : mult = 1（默认，零漂移）。
 *   - signal_weighted : mult = floor + (cap−floor)×q（none → mult=1）。
 *   - source_kelly    : mult = 源级历史凯利乘子（装载期预算一次，见 computeSourceKellyMult）。
 *
 * anchorMode 首行短路 fixed（不变量：realizedRetNet ≡ ret）。
 */

import { calcSignalStats } from '../signal-stats/signal-stats.metrics';
import { resolveRankSpec } from './portfolio-sim.factor-registry';
import { EngineTrade, PortfolioSimSource } from './portfolio-sim.types';

/** 最小有效下注（元）；alloc < 此值（非 anchorMode）→ skip 'sized_out'。 */
export const MIN_ALLOC_YUAN = 1;

/** computeAlloc 上下文。 */
export interface ComputeAllocCtx {
  /** 锚点模式：强制 fixed（首行短路）。 */
  anchorMode: boolean;
  /** 日内质量分位（来自 rankAndScore）；signal_weighted 用。 */
  qualityByTrade: Map<EngineTrade, number>;
  /** source_kelly 预算乘子（装载期 computeSourceKellyMult 算一次）。 */
  sourceKellyMult?: number;
}

/** 数值 clamp 到 [lo, hi]。 */
function clamp(x: number, lo: number, hi: number): number {
  return x < lo ? lo : x > hi ? hi : x;
}

/**
 * 单笔开仓金额（spec 04 §computeAlloc）。checkSkip 与开仓必须传入完全相同的结果。
 *
 *   anchorMode          → positionRatio × navRef（不变量）
 *   fixed               → mult = 1
 *   signal_weighted     → none → 1；否则 floor + (cap−floor)×q
 *   source_kelly        → ctx.sourceKellyMult ?? 1
 *
 * @returns alloc（元） = positionRatio × mult × navRef
 */
export function computeAlloc(
  trade: EngineTrade,
  source: PortfolioSimSource,
  navRef: number,
  ctx: ComputeAllocCtx,
): number {
  // 不变量：anchorMode 强制 fixed。
  if (ctx.anchorMode) {
    return source.positionRatio * navRef;
  }

  const mode = source.sizing?.mode ?? 'fixed';
  const base = source.positionRatio;
  const factors = resolveRankSpec(source);

  let mult: number;
  switch (mode) {
    case 'signal_weighted': {
      if (factors.length === 0) {
        // none → 真 fixed（不走 (floor+cap)/2，避免非对称 floor/cap 整体放缩）。
        mult = 1;
      } else {
        const sizing = source.sizing!;
        const q = ctx.qualityByTrade.get(trade) ?? 0.5;
        mult = sizing.floorMult + (sizing.capMult - sizing.floorMult) * q;
      }
      break;
    }
    case 'source_kelly':
      mult = ctx.sourceKellyMult ?? 1;
      break;
    case 'fixed':
    default:
      mult = 1;
      break;
  }

  return base * mult * navRef;
}

/**
 * 源级历史凯利乘子（spec 04 §source_kelly）。装载期 per source 预算一次（非 per-trade）。
 *
 * 用该源全逐笔 ret 喂 calcSignalStats 取 kellyF，按 avgWin/avgLoss 分流：
 *   kf != null → 负期望（kf≤0）→ 0；正 → clamp(kf × kellyFraction, 0, kellyMaxMult)
 *   kf == null（凯利未定义）:
 *     全亏源（avgWin==null && avgLoss!=null，最差）→ mult = 0（→ sized_out）
 *     其余（全胜/全平/样本不足，无法定凯利）       → mult = 1（中性 fixed，不惩罚）+ warn
 *
 * @param rets       该源全部逐笔 ret
 * @param sizing     该源 sizing 配置（取 kellyFraction/kellyMaxMult）
 * @param warn       退化 fixed 时的 warn 回调（注入，纯函数不直接依赖 logger）
 */
export function computeSourceKellyMult(
  rets: number[],
  sizing: { kellyFraction: number; kellyMaxMult: number },
  warn?: (msg: string) => void,
): number {
  const stats = calcSignalStats(
    rets,
    rets.map(() => 1),
  );
  const kf = stats.kellyF;

  if (kf !== null) {
    // 负期望 → 0（sized_out）；正 → 双重 clamp。
    return kf <= 0 ? 0 : clamp(kf * sizing.kellyFraction, 0, sizing.kellyMaxMult);
  }

  // kellyF 未定义：按 avgWin/avgLoss 分流。
  if (stats.avgWin === null && stats.avgLoss !== null) {
    // 全亏源（有亏无盈）→ 最差 → 0。
    return 0;
  }
  // 全胜 / 全平 / 样本不足 → 无法定凯利 → 中性 fixed（不惩罚）+ warn。
  warn?.('source_kelly kellyF=null（全胜/全平/样本不足），退化 fixed（mult=1）');
  return 1;
}
