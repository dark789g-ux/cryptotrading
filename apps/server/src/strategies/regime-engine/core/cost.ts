/**
 * portfolio-sim.cost.ts
 *
 * 交易成本模型纯函数 + 三档预设（不依赖 DB / NestJS）。
 *
 * 口径（02 引擎设计 §成本模型）：
 *   买入费率 = commission + transfer + slippage
 *   卖出费率 = commission + transfer + stamp(exitDate) + slippage
 *   印花税时变：exitDate >= '20230828' 用减半后 0.0005，否则 0.001。
 *     —— exitDate 为 YYYYMMDD 字符串，**直接字符串比较**（禁止 new Date 转换，避免 TZ/解析坑）。
 */

import { PortfolioSimCostRates } from './types';

/** 印花税减半生效日（YYYYMMDD）。exitDate >= 此值用减半后费率。 */
export const STAMP_HALVE_DATE = '20230828';

/**
 * 给定卖出日，返回适用的印花税率（字符串比较，不转 Date）。
 *
 * @param exitDate YYYYMMDD
 */
export function stampRateForExitDate(
  rates: PortfolioSimCostRates,
  exitDate: string,
): number {
  return exitDate >= STAMP_HALVE_DATE
    ? rates.stampSellFrom20230828
    : rates.stampSellBefore20230828;
}

/** 买入单边费率 = commission + transfer + slippage（与卖出日无关）。 */
export function buyRate(rates: PortfolioSimCostRates): number {
  return rates.commissionPerSide + rates.transferPerSide + rates.slippagePerSide;
}

/**
 * 卖出单边费率 = commission + transfer + stamp(exitDate) + slippage。
 *
 * @param exitDate 卖出日 YYYYMMDD（决定印花税档）。
 */
export function sellRate(
  rates: PortfolioSimCostRates,
  exitDate: string,
): number {
  return (
    rates.commissionPerSide +
    rates.transferPerSide +
    stampRateForExitDate(rates, exitDate) +
    rates.slippagePerSide
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// 预设档（导出常量）
// ─────────────────────────────────────────────────────────────────────────────

/** 佣金现实值（万 2.5）。 */
export const COMMISSION_REALISTIC = 0.00025;
/** 过户费现实值。 */
export const TRANSFER_REALISTIC = 0.00001;
/** 印花税：2023-08-28 减半前。 */
export const STAMP_BEFORE = 0.001;
/** 印花税：2023-08-28 减半后。 */
export const STAMP_FROM = 0.0005;

/** 滑点三档。 */
export const SLIPPAGE_OPTIMISTIC = 0; // 乐观
export const SLIPPAGE_REALISTIC = 0.0005; // 现实
export const SLIPPAGE_CONSERVATIVE = 0.001; // 保守

/** 共享的佣金 / 过户费 / 印花税（三现实档仅滑点不同）。 */
function realisticBase(slippage: number): PortfolioSimCostRates {
  return {
    commissionPerSide: COMMISSION_REALISTIC,
    transferPerSide: TRANSFER_REALISTIC,
    stampSellBefore20230828: STAMP_BEFORE,
    stampSellFrom20230828: STAMP_FROM,
    slippagePerSide: slippage,
  };
}

/** 乐观档：滑点 0，其余现实。 */
export const COST_PRESET_OPTIMISTIC: PortfolioSimCostRates =
  realisticBase(SLIPPAGE_OPTIMISTIC);

/** 现实档：滑点 0.0005，其余现实。 */
export const COST_PRESET_REALISTIC: PortfolioSimCostRates =
  realisticBase(SLIPPAGE_REALISTIC);

/** 保守档：滑点 0.001，其余现实。 */
export const COST_PRESET_CONSERVATIVE: PortfolioSimCostRates =
  realisticBase(SLIPPAGE_CONSERVATIVE);

/** 零成本档：全 0（anchorMode / 代数恒等校验用）。 */
export const COST_PRESET_ZERO: PortfolioSimCostRates = {
  commissionPerSide: 0,
  transferPerSide: 0,
  stampSellBefore20230828: 0,
  stampSellFrom20230828: 0,
  slippagePerSide: 0,
};
