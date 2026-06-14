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
  PortfolioRankFactorKey,
  PortfolioRankDir,
  SizingConfig,
  CircuitBreaker,
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

// ── 多因子排序选项（镜像后端 RANK_FACTOR_REGISTRY，spec 02）─────────────────────

/** 单个因子的展示元数据（镜像注册表 label / histAvailable / defaultDir）。 */
export interface RankFactorOption {
  value: PortfolioRankFactorKey
  /** 展示名（含历史不足警示，前向专用因子带 ⚠️）。 */
  label: string
  /** 是否历史可回测；false → 该因子历史几乎全 null、仅前向有效。 */
  histAvailable: boolean
  /** UI 初值方向（与注册表 defaultDir 一致）。 */
  defaultDir: PortfolioRankDir
}

/**
 * 9 因子选项（与后端 portfolio-sim.factor-registry.ts 的 RANK_FACTOR_REGISTRY 逐条镜像：
 * key / label / histAvailable / defaultDir）。⚠️ 改后端注册表须同步本数组（无编译期联动）。
 * ml_score histAvailable=false → label 标「⚠️历史仅2天·前向专用」，前端灰提示。
 */
export const RANK_FACTOR_OPTIONS: RankFactorOption[] = [
  { value: 'pos_120', label: '120日价格位置', histAvailable: true, defaultDir: 'asc' },
  { value: 'pos_60', label: '60日价格位置', histAvailable: true, defaultDir: 'asc' },
  { value: 'close_ma60_ratio', label: 'close/ma60 比', histAvailable: true, defaultDir: 'asc' },
  { value: 'vol_ratio_60', label: '量比60', histAvailable: true, defaultDir: 'asc' },
  { value: 'vol_ratio_120', label: '量比120', histAvailable: true, defaultDir: 'asc' },
  { value: 'risk_reward', label: '盈亏比', histAvailable: true, defaultDir: 'desc' },
  { value: 'momentum_60', label: '动量(ATR标准化)', histAvailable: true, defaultDir: 'desc' },
  { value: 'circ_mv', label: '流通市值', histAvailable: true, defaultDir: 'asc' },
  {
    value: 'ml_score',
    label: 'ML 评分 ⚠️历史仅2天·前向专用',
    histAvailable: false,
    defaultDir: 'desc',
  },
]

/** value → option 速查（FillsTable 逐因子展示、SourceRow 加因子取默认方向用）。 */
export const RANK_FACTOR_OPTION_MAP: Record<PortfolioRankFactorKey, RankFactorOption> =
  RANK_FACTOR_OPTIONS.reduce(
    (acc, o) => {
      acc[o.value] = o
      return acc
    },
    {} as Record<PortfolioRankFactorKey, RankFactorOption>,
  )

export const RANK_DIR_OPTIONS: Array<{ label: string; value: PortfolioRankDir }> = [
  { label: '升序（值小优先）', value: 'asc' },
  { label: '降序（值大优先）', value: 'desc' },
]

// ── 仓位模式选项（镜像后端 SizingConfig.mode）─────────────────────────────────

export const SIZING_MODE_OPTIONS: Array<{ label: string; value: SizingConfig['mode'] }> = [
  { label: '固定（positionRatio）', value: 'fixed' },
  { label: '信号加权（按排序分缩放）', value: 'signal_weighted' },
  { label: '源凯利（按源历史凯利缩放）', value: 'source_kelly' },
]

/** SizingConfig 默认值（镜像后端默认：fixed + floor0.5/cap1.5 + kelly0.5/max1.0）。 */
export const DEFAULT_SIZING: SizingConfig = {
  mode: 'fixed',
  floorMult: 0.5,
  capMult: 1.5,
  kellyFraction: 0.5,
  kellyMaxMult: 1.0,
}

// ── 熔断默认值（镜像后端 CircuitBreaker 缺省 = 全关）──────────────────────────

/**
 * CircuitBreaker 默认值：双闸全关，阈值取 spec 示例（连亏 3 笔 / 回撤 15% 停、10% 复）。
 * 开关关闭时阈值仍带默认，便于用户开闸即用。
 */
export const DEFAULT_CIRCUIT_BREAKER: CircuitBreaker = {
  enableCooldown: false,
  consecutiveLossesThreshold: 3,
  baseCooldownDays: 3,
  maxCooldownDays: 10,
  extendOnLoss: 2,
  reduceOnProfit: 1,
  enableDrawdownHalt: false,
  drawdownHaltPct: 0.15,
  drawdownResumePct: 0.1,
}

// ── 弃单原因标签（镜像后端 SkipReason，含 Phase 2/3 三新原因）──────────────────

export const SKIP_REASON_LABELS: Record<string, string> = {
  already_held: '已持有同标的',
  slots_full: '持仓数已满',
  exposure_cap: '超敞口上限',
  cash_short: '现金不足',
  cooldown: '连亏熔断',
  drawdown_halt: '回撤熔断',
  sized_out: '凯利归零',
}
