import { RegimeConfigMap } from '../../../entities/strategy/regime-strategy-config.entity';
import { MarketSnapshot } from '../market-condition-evaluator';
import { PortfolioSimCostRates, SizingConfig, CircuitBreaker, SkipReason } from '../core/types';
import { SimulationInput, SimulatedTrade } from '../core/exit-simulator';
import { EngineDailyRow, EngineSummary } from '../core/summary';

export interface RegimeBacktestCapital {
  initialCapital: number;
  cost: PortfolioSimCostRates;
  /** @deprecated 产品层已移除；旧快照可能仍有。开仓 sizing 取当日象限。 */
  positionRatio?: number;
  /** @deprecated 产品层已移除；旧快照可能仍有。开仓 sizing 取当日象限。 */
  maxPositions?: number | null;
  sizing?: SizingConfig;
  circuitBreaker?: CircuitBreaker;
  anchorMode?: boolean;
}

export interface RegimeBacktestSignal {
  signalDate: string;
  buyDate: string;
  tsCode: string;
  simulationInput: SimulationInput;
}

export interface RegimeBacktestInput {
  regimeConfig: RegimeConfigMap;
  capital: RegimeBacktestCapital;
  calendar: string[];
  marketSnapshots: Map<string, MarketSnapshot>;
  signalsByDate: Map<string, RegimeBacktestSignal[]>;
}

export interface RegimeBacktestTrade {
  signalDate: string;
  buyDate: string;
  exitDate: string | null;
  tsCode: string;
  regime: string;
  exitMode: string;
  status: 'taken' | 'skipped';
  skipReason?: SkipReason;
  ret?: number;
  exitReason?: string;
  alloc?: number;
  costsPaid?: number;
  realizedRetNet?: number;
  rank?: number;
  rankField?: string;
  rankValue?: number | null;
}

export interface RegimeBacktestResult {
  dailyRows: EngineDailyRow[];
  trades: RegimeBacktestTrade[];
  summary: EngineSummary;
}
