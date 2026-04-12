/** 持仓数据 */
export interface Position {
  symbol: string;
  entryPrice: number;
  entryTime: string;
  entryIdx: number;
  shares: number;
  allocated: number;
  stopPrice: number;
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
}

export function createPosition(p: Partial<Position> & {
  symbol: string; entryPrice: number; entryTime: string;
  entryIdx: number; shares: number; allocated: number;
  stopPrice: number; recentHigh: number;
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
  [key: string]: any;
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
  kdjKMax: number;
  kdjDMax: number;
  kdjJMax: number;
  stopLossFactor: number;
  enablePartialProfit: boolean;
  maxInitLoss: number;
  minRiskRewardRatio: number;
  cooldownHours: number;
  consecutiveLossesThreshold: number;
  baseCooldownCandles: number;
  maxCooldownCandles: number;
  consecutiveLossesReduceOnProfit: number;
  warmupBars: number;
  maxBacktestBars: number;
  lookbackBuffer: number;
  minOpenCash: number;
}

export const DEFAULT_CONFIG: BacktestConfig = {
  initialCapital: 1000000,
  positionRatio: 0.40,
  maxPositions: 2,
  timeframe: '1h',
  dateStart: '',
  dateEnd: '',
  maPeriods: [30, 60, 120, 240],
  kdjKMax: 200,
  kdjDMax: 200,
  kdjJMax: 0,
  stopLossFactor: 1.0,
  enablePartialProfit: false,
  maxInitLoss: 0.01,
  minRiskRewardRatio: 4.0,
  cooldownHours: 2,
  consecutiveLossesThreshold: 2,
  baseCooldownCandles: 1,
  maxCooldownCandles: 10000,
  consecutiveLossesReduceOnProfit: 2,
  warmupBars: 240,
  maxBacktestBars: 10000,
  lookbackBuffer: 50,
  minOpenCash: 100,
};
