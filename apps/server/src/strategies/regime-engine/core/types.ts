/**
 * core/types.ts
 *
 * regime-engine 回测层共享的资金管理类型（从 portfolio-sim.types.ts 迁入）。
 * 供 core/ 下的 cost / sizing / cooldown 纯函数引用。
 */

/** 交易成本费率（均为小数费率，单边）。 */
export interface PortfolioSimCostRates {
  /** 佣金（单边）。 */
  commissionPerSide: number;
  /** 过户费（单边）。 */
  transferPerSide: number;
  /** 印花税（仅卖出）：exitDate < '20230828'（2023-08-28 减半前）。 */
  stampSellBefore20230828: number;
  /** 印花税（仅卖出）：exitDate >= '20230828'（减半后）。 */
  stampSellFrom20230828: number;
  /** 滑点（单边）。 */
  slippagePerSide: number;
}

/**
 * 动态仓位配置。缺省 = fixed（固定 positionRatio）。
 * fixed 不读 floorMult/capMult/kellyFraction/kellyMaxMult 字段。
 */
export interface SizingConfig {
  /** 仓位模式。缺省 'fixed'。 */
  mode: 'fixed' | 'signal_weighted' | 'source_kelly';
  /** signal_weighted 最差信号乘子，默认 0.5（须 >0）。 */
  floorMult: number;
  /** signal_weighted 最优信号乘子，默认 1.5（须 ≥ floorMult）。 */
  capMult: number;
  /** source_kelly half-kelly 系数，默认 0.5，范围 (0,1]。 */
  kellyFraction: number;
  /** source_kelly 乘子上限，默认 1.0，范围 (0,∞)。 */
  kellyMaxMult: number;
}

/**
 * 账户级熔断配置。缺省 = 全关。
 * 连亏熔断（cooldown）+ 回撤熔断（drawdown）双触发。
 */
export interface CircuitBreaker {
  /** 连亏熔断开关。 */
  enableCooldown: boolean;
  /** 连亏 N 笔触发，正整数。 */
  consecutiveLossesThreshold: number;
  /** 基础冷却交易日数。 */
  baseCooldownDays: number;
  /** 冷却上限（≥ base）。 */
  maxCooldownDays: number;
  /** 每次亏损延长天数（非负整数）。 */
  extendOnLoss: number;
  /** 每次盈利缩短天数（非负整数）。 */
  reduceOnProfit: number;
  /** 回撤熔断开关。 */
  enableDrawdownHalt: boolean;
  /** 自峰值回撤 ≥ 此值停开仓，如 0.15。 */
  drawdownHaltPct: number;
  /** 回升到回撤 ≤ 此值恢复（滞回），须 ≤ haltPct。 */
  drawdownResumePct: number;
}

/** 开仓被拒绝的原因。 */
export type SkipReason =
  | 'already_held' // 已持有同 ts_code
  | 'slots_full' // 在仓数 >= maxPositions
  | 'exposure_cap' // 敞口超上限
  | 'cash_short' // cash < alloc + 买费
  | 'cooldown' // 连亏熔断冷却期内冻结开仓
  | 'drawdown_halt' // 回撤熔断停开仓
  | 'sized_out' // 仓位算出来 ≈0
  | 'regime_flat'; // regime 当日不开仓
