export interface TakeProfitTarget {
  rrRatio: number;
  sellRatio: number;
}

export type MaOperand = 'close' | 'ma5' | 'ma30' | 'ma60' | 'ma120' | 'ma240';
export type MaOperator = '>' | '>=' | '<' | '<=' | '=' | '!=';

export interface MaCondition {
  left: MaOperand;
  op: MaOperator;
  right: MaOperand;
}

/** 持仓数据 */
export interface Position {
  symbol: string;
  entryPrice: number;
  entryTime: string;
  entryIdx: number;
  shares: number;
  allocated: number;
  stopPrice: number;
  initialStop: number;
  recentHigh: number;
  candleCount: number;
  maxClose: number;
  macdRose: boolean;
  macdWasRising: boolean;
  halfSold: boolean;
  halfSellPrice: number;
  halfSellTime: string;
  stopReason: string;
  entryRrRatio: number;
  brokeMa5: boolean;
  ma5StopAdjusted: boolean;
  recentHighTime: string;
  recentLowTime: string;
  entryReason: string;
  breakevenTriggered: boolean;
  trailingProfitActive: boolean;
  trailingProfitHighClose: number;
  takeProfitNextTargetIdx: number;
  ladderBreakevenHit: boolean;
  ladderStopFrozen: boolean;
  signalBarHigh: number;
}

export function createPosition(p: Partial<Position> & {
  symbol: string; entryPrice: number; entryTime: string;
  entryIdx: number; shares: number; allocated: number;
  stopPrice: number; initialStop: number; recentHigh: number;
}): Position {
  return {
    candleCount: 1,
    maxClose: p.entryPrice,
    macdRose: false,
    macdWasRising: false,
    halfSold: false,
    halfSellPrice: 0,
    halfSellTime: '',
    stopReason: '阶段低点止损',
    entryRrRatio: 0,
    brokeMa5: false,
    ma5StopAdjusted: false,
    recentHighTime: '',
    recentLowTime: '',
    entryReason: '',
    breakevenTriggered: false,
    trailingProfitActive: false,
    trailingProfitHighClose: 0,
    takeProfitNextTargetIdx: 0,
    ladderBreakevenHit: false,
    ladderStopFrozen: false,
    signalBarHigh: 0,
    ...p,
  };
}

/** 交易记录 */
export interface TradeRecord {
  symbol: string;
  entryTime: string;
  entryPrice: number;
  exitTime: string;
  exitPrice: number;
  shares: number;
  pnl: number;
  returnPct: number;
  exitReason: string;
  holdCandles: number;
  isHalf: boolean;
  entryReason: string;
}

/** K 线行（供回测引擎内部使用） */
export interface KlineBarRow {
  open_time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  DIF: number;
  DEA: number;
  MACD: number;
  'KDJ.K': number;
  'KDJ.D': number;
  'KDJ.J': number;
  MA5: number;
  MA30: number;
  MA60: number;
  MA120: number;
  MA240: number;
  [key: string]: unknown;
}

/** BacktestConfig — 与 Python BacktestConfig dataclass 字段完全对应 */
export interface BacktestConfig {
  initialCapital: number;
  positionRatio: number;
  maxPositions: number;
  timeframe: string;
  dateStart: string;
  dateEnd: string;
  maPeriods: number[];
  // 入场信号
  kdjN: number;
  kdjM1: number;
  kdjM2: number;
  kdjJOversold: number;
  /** 超卖比较使用的 J：0=当根，n=往前第 n 根 K 线的 J */
  kdjOversoldJOffset: number;
  maConditions: MaCondition[];
  entryMaxDistFromLowPct: number;
  brickXgEnabled: boolean;
  brickDeltaMin: number;
  // 信号参数
  recentLowWindow: number;
  recentLowBuffer: number;
  recentHighWindow: number;
  recentHighBuffer: number;
  // 止损策略
  stopLossMode: 'atr' | 'fixed' | 'signal_midpoint';
  stopLossFactor: number;
  fixedStopLossPct: number;
  enableProfitStopAdjust: boolean;
  profitStopAdjustTo: 'midpoint' | 'breakeven';
  enableMa5StopAdjust: boolean;
  ma5StopAdjustTo: 'midpoint' | 'breakeven';
  enableLadderStopLoss: boolean;
  // 出场管理
  enablePartialProfit: boolean;
  partialProfitRatio: number;
  enableTrailingStop: boolean;
  trailingDrawdownPct: number;
  enableBreakevenStop: boolean;
  breakevenTriggerR: number;
  takeProfitTargets: TakeProfitTarget[];
  enableTrailingProfit: boolean;
  trailingProfitTriggerR: number;
  trailingProfitDrawdownPct: number;
  // 风控参数
  maxInitLoss: number;
  minRiskRewardRatio: number;
  enableCooldown: boolean;
  consecutiveLossesThreshold: number;
  baseCooldownCandles: number;
  maxCooldownCandles: number;
  /** 每次亏损平仓：冷却时长与（若已在冷却）结束 bar 各增加若干根，非负整数 */
  cooldownExtendOnLoss: number;
  /** 每次盈利平仓：冷却时长与（若已在冷却）结束 bar 各减少若干根，非负整数 */
  cooldownReduceOnProfit: number;
  warmupBars: number;
  lookbackBuffer: number;
  maxBacktestBars: number;
  minOpenCash: number;
  requireAllPositionsProfitable: boolean;
}

// ─────────────────────────────────────────────────────────────
// candleLog 逐根事件类型
// ─────────────────────────────────────────────────────────────

/** 当根 K 线发生的入场事件 */
export interface CandleEntryEvent {
  symbol: string;
  price: number;
  shares: number;
  amount: number;
  reason: string;
}

/** 当根 K 线发生的出场事件 */
export interface CandleExitEvent {
  symbol: string;
  price: number;
  shares: number;
  amount: number;
  pnl: number;
  reason: string;
  isHalf: boolean;
}

/** 每根 K 线的快照日志 */
export interface CandleLogEntry {
  barIdx: number;
  ts: string;
  openEquity: number;
  closeEquity: number;
  posCount: number;
  maxPositions: number;
  entries: CandleEntryEvent[];
  exits: CandleExitEvent[];
  /** 本根收盘后持仓标的（与引擎 positions 同步） */
  openSymbols: string[];
  inCooldown: boolean;
  /** 当前全局冷却期时长（根数），enableCooldown=false 时为 null */
  cooldownDuration: number | null;
  /** 距冷却结束的剩余根数，非冷却期为 0，enableCooldown=false 时为 null */
  cooldownRemaining: number | null;
}

const SUPPORTED_TIMEFRAMES = new Set([
  '1m', '5m', '15m', '30m', '1h', '2h', '4h', '6h', '12h', '1d',
]);

export function validateConfig(config: BacktestConfig): void {
  const errs: string[] = [];
  if (!(config.initialCapital > 0)) errs.push('initialCapital 必须 > 0');
  if (!(config.positionRatio >= 0.01 && config.positionRatio <= 1))
    errs.push('positionRatio 必须在 [0.01, 1]');
  if (!(Number.isInteger(config.maxPositions) && config.maxPositions >= 1))
    errs.push('maxPositions 必须为正整数');
  if (!SUPPORTED_TIMEFRAMES.has(config.timeframe))
    errs.push(`timeframe 必须是 ${[...SUPPORTED_TIMEFRAMES].join('/')} 之一`);
  if (!(config.stopLossFactor > 0 && config.stopLossFactor <= 2))
    errs.push('stopLossFactor 必须在 (0, 2]');
  if (!(config.maxInitLoss > 0 && config.maxInitLoss < 1))
    errs.push('maxInitLoss 必须在 (0, 1)');
  if (config.minRiskRewardRatio < 0) errs.push('minRiskRewardRatio 不得为负');
  if (config.warmupBars < 0) errs.push('warmupBars 不得为负');
  if (config.maxBacktestBars < 0) errs.push('maxBacktestBars 不得为负');
  if (config.minOpenCash < 0) errs.push('minOpenCash 不得为负');
  // 冷却参数校验（仅启用时）
  if (config.enableCooldown) {
    if (config.consecutiveLossesThreshold < 1)
      errs.push('consecutiveLossesThreshold 必须 >= 1');
    if (config.baseCooldownCandles < 0) errs.push('baseCooldownCandles 不得为负');
    if (config.maxCooldownCandles < config.baseCooldownCandles)
      errs.push('maxCooldownCandles 不得小于 baseCooldownCandles');
    if (!Number.isInteger(config.cooldownExtendOnLoss) || config.cooldownExtendOnLoss < 0)
      errs.push('cooldownExtendOnLoss 必须为非负整数');
    if (!Number.isInteger(config.cooldownReduceOnProfit) || config.cooldownReduceOnProfit < 0)
      errs.push('cooldownReduceOnProfit 必须为非负整数');
  }
  // 信号参数
  if (!(config.recentLowWindow >= 1)) errs.push('recentLowWindow 必须 >= 1');
  if (!(config.recentLowBuffer >= 0)) errs.push('recentLowBuffer 不得为负');
  if (!(config.recentHighWindow >= 1)) errs.push('recentHighWindow 必须 >= 1');
  if (!(config.recentHighBuffer >= 0)) errs.push('recentHighBuffer 不得为负');
  if (
    !Number.isInteger(config.kdjOversoldJOffset) ||
    config.kdjOversoldJOffset < 0 ||
    config.kdjOversoldJOffset > 99
  ) {
    errs.push('kdjOversoldJOffset 必须为 0～99 的整数');
  }
  // 止损策略
  if (!['atr', 'fixed', 'signal_midpoint'].includes(config.stopLossMode))
    errs.push('stopLossMode 必须是 atr、fixed 或 signal_midpoint');
  if (!['midpoint', 'breakeven'].includes(config.profitStopAdjustTo))
    errs.push('profitStopAdjustTo 必须是 midpoint 或 breakeven');
  if (!['midpoint', 'breakeven'].includes(config.ma5StopAdjustTo))
    errs.push('ma5StopAdjustTo 必须是 midpoint 或 breakeven');
  if (config.stopLossMode === 'fixed' && !(config.fixedStopLossPct > 0 && config.fixedStopLossPct < 100))
    errs.push('fixedStopLossPct 必须在 (0, 100)');
  // 出场管理
  if (!(config.partialProfitRatio > 0 && config.partialProfitRatio < 1))
    errs.push('partialProfitRatio 必须在 (0, 1)');
  if (config.trailingDrawdownPct <= 0) errs.push('trailingDrawdownPct 必须 > 0');
  if (config.breakevenTriggerR <= 0) errs.push('breakevenTriggerR 必须 > 0');
  if (config.trailingProfitTriggerR <= 0) errs.push('trailingProfitTriggerR 必须 > 0');
  if (config.trailingProfitDrawdownPct <= 0) errs.push('trailingProfitDrawdownPct 必须 > 0');
  for (const t of config.takeProfitTargets) {
    if (!(t.rrRatio > 0)) errs.push('takeProfitTargets 每档 rrRatio 必须 > 0');
    if (!(t.sellRatio > 0 && t.sellRatio <= 1)) errs.push('takeProfitTargets 每档 sellRatio 必须在 (0, 1]');
  }
  if (errs.length) throw new Error(`策略参数非法: ${errs.join('; ')}`);
}

export const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 1000000,
  positionRatio: 0.40,
  maxPositions: 2,
  timeframe: '1h',
  dateStart: '',
  dateEnd: '',
  maPeriods: [30, 60, 120, 240],
  // 入场信号
  kdjN: 9,
  kdjM1: 3,
  kdjM2: 3,
  kdjJOversold: 10,
  kdjOversoldJOffset: 0,
  maConditions: [],
  entryMaxDistFromLowPct: 0,
  brickXgEnabled: false,
  brickDeltaMin: 0,
  // 信号参数
  recentLowWindow: 9,
  recentLowBuffer: 5,
  recentHighWindow: 9,
  recentHighBuffer: 5,
  // 止损策略
  stopLossMode: 'atr',
  stopLossFactor: 1.0,
  fixedStopLossPct: 2,
  enableProfitStopAdjust: true,
  profitStopAdjustTo: 'midpoint',
  enableMa5StopAdjust: true,
  ma5StopAdjustTo: 'midpoint',
  enableLadderStopLoss: false,
  // 出场管理
  enablePartialProfit: false,
  partialProfitRatio: 0.5,
  enableTrailingStop: false,
  trailingDrawdownPct: 3,
  enableBreakevenStop: false,
  breakevenTriggerR: 1.0,
  takeProfitTargets: [],
  enableTrailingProfit: false,
  trailingProfitTriggerR: 2.0,
  trailingProfitDrawdownPct: 5,
  // 风控参数
  maxInitLoss: 0.01,
  minRiskRewardRatio: 4.0,
  enableCooldown: false,
  consecutiveLossesThreshold: 3,
  baseCooldownCandles: 5,
  maxCooldownCandles: 20,
  cooldownExtendOnLoss: 1,
  cooldownReduceOnProfit: 1,
  warmupBars: 240,
  lookbackBuffer: 0,
  maxBacktestBars: 10000,
  minOpenCash: 100,
  requireAllPositionsProfitable: false,
};
