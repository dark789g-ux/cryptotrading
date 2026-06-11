/**
 * portfolioSimPresets.ts —— 组合模拟器前端常量镜像 + 派生展示工具。
 *
 * 费率预设：镜像后端 apps/server/src/strategy-conditions/portfolio-sim/portfolio-sim.cost.ts
 *   的导出常量值（COMMISSION_REALISTIC=0.00025 / TRANSFER_REALISTIC=0.00001 /
 *   STAMP_BEFORE=0.001 / STAMP_FROM=0.0005 / 滑点三档 0 / 0.0005 / 0.001）。
 *   ⚠️ 这是「镜像展示」常量——真实计算在后端，前端值仅用于表单默认与档位灰字预览，
 *   改后端 cost.ts 时须同步本文件（无编译期联动）。
 *
 * 象限预设：来源 regime config v1（0AMV 四象限分阶段策略）。常量硬编码于前端，
 *   选中即填 label / exposureCap / rankField，仅为操作便利，不代表后端约束。
 */
import type {
  PortfolioSimCostRates,
  PortfolioRankField,
} from '../../api/modules/strategy/portfolioSim'

// ── 费率预设（镜像后端 portfolio-sim.cost.ts）────────────────────────────────

/** 佣金现实值（万 2.5）。来源：cost.ts COMMISSION_REALISTIC */
export const COMMISSION_REALISTIC = 0.00025
/** 过户费现实值。来源：cost.ts TRANSFER_REALISTIC */
export const TRANSFER_REALISTIC = 0.00001
/** 印花税：2023-08-28 减半前。来源：cost.ts STAMP_BEFORE */
export const STAMP_BEFORE = 0.001
/** 印花税：2023-08-28 减半后。来源：cost.ts STAMP_FROM */
export const STAMP_FROM = 0.0005
/** 滑点三档。来源：cost.ts SLIPPAGE_OPTIMISTIC / REALISTIC / CONSERVATIVE */
export const SLIPPAGE_OPTIMISTIC = 0
export const SLIPPAGE_REALISTIC = 0.0005
export const SLIPPAGE_CONSERVATIVE = 0.001

function realisticBase(slippage: number): PortfolioSimCostRates {
  return {
    commissionPerSide: COMMISSION_REALISTIC,
    transferPerSide: TRANSFER_REALISTIC,
    stampSellBefore20230828: STAMP_BEFORE,
    stampSellFrom20230828: STAMP_FROM,
    slippagePerSide: slippage,
  }
}

export const COST_PRESET_OPTIMISTIC: PortfolioSimCostRates = realisticBase(SLIPPAGE_OPTIMISTIC)
export const COST_PRESET_REALISTIC: PortfolioSimCostRates = realisticBase(SLIPPAGE_REALISTIC)
export const COST_PRESET_CONSERVATIVE: PortfolioSimCostRates = realisticBase(SLIPPAGE_CONSERVATIVE)
export const COST_PRESET_ZERO: PortfolioSimCostRates = {
  commissionPerSide: 0,
  transferPerSide: 0,
  stampSellBefore20230828: 0,
  stampSellFrom20230828: 0,
  slippagePerSide: 0,
}

export type CostTier = 'optimistic' | 'realistic' | 'conservative' | 'zero' | 'custom'

export const COST_TIER_PRESETS: Record<
  Exclude<CostTier, 'custom'>,
  PortfolioSimCostRates
> = {
  optimistic: COST_PRESET_OPTIMISTIC,
  realistic: COST_PRESET_REALISTIC,
  conservative: COST_PRESET_CONSERVATIVE,
  zero: COST_PRESET_ZERO,
}

export const COST_TIER_LABELS: Record<CostTier, string> = {
  optimistic: '乐观（滑点 0）',
  realistic: '现实（滑点万5）',
  conservative: '保守（滑点千1）',
  zero: '零成本（对账用）',
  custom: '自定义',
}

/**
 * 给定费率，估算「双边合计」≈ 买费率 + 卖费率（卖费率取减半后印花税档作展示口径）。
 * 仅用于档位旁灰字预览，非精确（印花税实际随出场日时变）。
 */
export function estimateRoundTripRate(rates: PortfolioSimCostRates): number {
  const buy = rates.commissionPerSide + rates.transferPerSide + rates.slippagePerSide
  const sell = buy + rates.stampSellFrom20230828
  return buy + sell
}

/** 把小数费率格式化为「万 X」/百分比可读串（展示用）。 */
export function formatRatePct(rate: number): string {
  return `${(rate * 100).toFixed(3)}%`
}

// ── 象限预设（来源 regime config v1）─────────────────────────────────────────

export type QuadrantPreset = 'none' | 'Q3' | 'Q1'

export interface QuadrantPresetValue {
  label: string
  exposureCap: number | null
  rankField: PortfolioRankField
  rankDir: 'asc' | 'desc'
}

/**
 * Q3 主选 / Q1 主选快捷预设（regime config v1）。
 * 选中即把这些值填入对应源行：Q3 → exposureCap 0.33 / rankField pos_120 升序；
 * Q1 → exposureCap 0.15 / rankField circ_mv 升序。
 */
export const QUADRANT_PRESETS: Record<Exclude<QuadrantPreset, 'none'>, QuadrantPresetValue> = {
  Q3: { label: 'Q3主选', exposureCap: 0.33, rankField: 'pos_120', rankDir: 'asc' },
  Q1: { label: 'Q1主选', exposureCap: 0.15, rankField: 'circ_mv', rankDir: 'asc' },
}

export const QUADRANT_PRESET_LABELS: Record<QuadrantPreset, string> = {
  none: '无（手动配置）',
  Q3: 'Q3 主选（跨年稳健）',
  Q1: 'Q1 主选（靠 2025）',
}

// ── rankField 展示 ───────────────────────────────────────────────────────────

export const RANK_FIELD_OPTIONS: Array<{ label: string; value: PortfolioRankField }> = [
  { label: 'pos_120（升序，越低越优先）', value: 'pos_120' },
  { label: 'circ_mv（升序，小市值优先）', value: 'circ_mv' },
  { label: '不排序（按 ts_code）', value: 'none' },
]

export const SKIP_REASON_LABELS: Record<string, string> = {
  already_held: '已持有同标的',
  slots_full: '持仓数已满',
  exposure_cap: '超敞口上限',
  cash_short: '现金不足',
}
