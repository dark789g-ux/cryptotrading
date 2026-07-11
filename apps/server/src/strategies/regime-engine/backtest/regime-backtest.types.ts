import { RegimeConfigMap } from '../../../entities/strategy/regime-strategy-config.entity';
import { MarketSnapshot } from '../market-condition-evaluator';
import { PortfolioSimCostRates, SizingConfig, CircuitBreaker, SkipReason } from '../core/types';
import { SimulationInput } from '../core/exit-simulator';
import { EngineDailyRow, EngineSummary } from '../core/summary';

export interface RegimeKellyConfig {
  enabled: boolean;
  simTrades: number;
  windowTrades: number;
  stepTrades: number;
  kellyFraction: number;
  kellyMaxMult: number;
  enableProbe: boolean;
}

export interface RegimeBacktestCapital {
  initialCapital: number;
  cost: PortfolioSimCostRates;
  /** @deprecated 产品层已移除；旧快照可能仍有。开仓 sizing 取当日象限。 */
  positionRatio?: number;
  /** @deprecated 产品层已移除；旧快照可能仍有。开仓 sizing 取当日象限。 */
  maxPositions?: number | null;
  sizing?: SizingConfig;
  kelly?: RegimeKellyConfig;
  circuitBreaker?: CircuitBreaker;
  anchorMode?: boolean;
  /** 仅当全部现存持仓市值 ≥ 成本时才允许开新仓。 */
  requireAllPositionsProfitable?: boolean;
  // TODO(P2b): enablePartialProfit + partialProfitRatio — 阶段止盈（日线 recentHigh 触发部分减仓）
}

export interface RegimeBacktestSignal {
  signalDate: string;
  buyDate: string;
  tsCode: string;
  /**
   * 持有窗口行情包（buyDate→dateEnd），供日频 init/step 与 MTM。
   * 不再在开仓时一次性预演卖点；exitDate/ret 由引擎日循环写入。
   */
  simulationInput: SimulationInput;
}

export interface RegimeBacktestInput {
  regimeConfig: RegimeConfigMap;
  capital: RegimeBacktestCapital;
  calendar: string[];
  marketSnapshots: Map<string, MarketSnapshot>;
  signalsByDate: Map<string, RegimeBacktestSignal[]>;
}

export type RegimeTradePhase = 'simulation' | 'probe' | 'live';

export interface RegimeBacktestTrade {
  signalDate: string;
  buyDate: string;
  exitDate: string | null;
  tsCode: string;
  regime: string;
  exitMode: string;
  status: 'taken' | 'skipped';
  skipReason?: SkipReason;
  tradePhase?: RegimeTradePhase;
  ret?: number;
  exitReason?: string;
  alloc?: number;
  costsPaid?: number;
  realizedRetNet?: number;
  rank?: number;
  rankField?: string;
  rankValue?: number | null;
}

export interface RegimeDailyAuditEntry {
  tsCode: string;
  signalDate: string;
  buyDate: string;
  status: 'taken' | 'skipped';
  skipReason?: SkipReason;
  alloc?: number;
  tradePhase?: RegimeTradePhase;
}

export interface RegimeDailyAuditExit {
  tsCode: string;
  exitDate: string;
  ret?: number;
  realizedRetNet?: number;
  exitReason?: string;
  tradePhase?: RegimeTradePhase;
}

export interface RegimeDailyCooldownSnapshot {
  inCooldown: boolean;
  duration: number;
  remaining: number | null;
  consecLosses: number;
}

export interface RegimeDailyAuditRow {
  tradeDate: string;
  nav: number;
  cash: number;
  regime: string;
  frozenReason: 'cooldown' | 'drawdown_halt' | null;
  tradePhase: RegimeTradePhase;
  entries: RegimeDailyAuditEntry[];
  exits: RegimeDailyAuditExit[];
  cooldown: RegimeDailyCooldownSnapshot;
  openSymbols: string[];
}

export interface RegimeBacktestResult {
  dailyRows: EngineDailyRow[];
  auditRows: RegimeDailyAuditRow[];
  trades: RegimeBacktestTrade[];
  summary: EngineSummary;
}
