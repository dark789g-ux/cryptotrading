import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StrategyConditionItem } from './strategy-condition.entity';
import type {
  PortfolioSimCostRates,
  RankSpec,
  SizingConfig,
  CircuitBreaker,
  RegimeRule,
} from '../../strategy-conditions/portfolio-sim/portfolio-sim.types';

export { type SignalTestUniverse } from '../../strategy-conditions/strategy-conditions.enumerator';
import type { SignalTestUniverse } from '../../strategy-conditions/strategy-conditions.enumerator';

/**
 * 迷你回测配置（signal_test.backtest_config，null = 不跑回测，存量行零漂移）。
 *
 * 扁平化单源 PortfolioSimConfig（spec 03 §3.2）：signal_test 永远单源，
 * 不嵌 sources:[...]；后端适配层（spec 04）负责组装成引擎要的
 * PortfolioSimConfig{ sources:[{...}] }。子类型复用 portfolio-sim.types.ts。
 */
export interface SignalTestBacktestConfig {
  /** 初始资金（首日 NAV_ref）。 */
  initialCapital: number;
  /** 交易成本费率（单边）。 */
  cost: PortfolioSimCostRates;
  /** 锚点模式：约束停用、费率全 0、每笔必 taken。 */
  anchorMode: boolean;
  /** 单票权重占 NAV_ref，(0,1]。 */
  positionRatio: number;
  /** 最大同时在仓数；null = 不限。 */
  maxPositions: number | null;
  /** 总敞口上限占 NAV_ref；null = 不限。 */
  exposureCap: number | null;
  /** 多因子排序规格；factors=[] → 不排序（按 ts_code 升序）。 */
  rankSpec: RankSpec;
  /** 动态仓位配置；mode='fixed' = 固定 positionRatio。 */
  sizing: SizingConfig;
  /** 账户级熔断；null = 全关。 */
  circuitBreaker: CircuitBreaker | null;
  /**
   * 账户级 regime 调仓（spec 2026-06-15）；缺省 / 空 = 不启用（零漂移，走源静态 maxPositions/positionRatio）。
   * 配了之后：按列表顺序首个全条件命中生效、覆盖所有源；无命中 / 缺数据当天不开仓（fail-closed）。
   */
  regimes?: RegimeRule[];
}

@Entity('signal_test')
export class SignalTestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'jsonb', name: 'buy_conditions' })
  buyConditions: StrategyConditionItem[];

  // 列为 varchar(16) 无 DB CHECK；trailing_lock 波段跟踪止损出场新增（spec，无需迁移）。
  // phase_lock 分阶段锁定出场新增（spec，varchar(16) 无 CHECK，新增枚举值无需迁移）。
  @Column({ type: 'varchar', length: 16, name: 'exit_mode' })
  exitMode: 'fixed_n' | 'strategy' | 'trailing_lock' | 'phase_lock';

  @Column({ type: 'int', nullable: true, name: 'horizon_n' })
  horizonN: number | null;

  @Column({ type: 'jsonb', nullable: true, name: 'exit_conditions' })
  exitConditions: StrategyConditionItem[] | null;

  @Column({ type: 'int', nullable: true, name: 'max_hold' })
  maxHold: number | null;

  /**
   * 波段跟踪止损额外参数（仅 trailing_lock）；null = 全默认（存量行零漂移）。
   * 存入的是已量化（round-half-up 到 0.001）的网格点 ratio——runner 直接透传给核，核不再量化。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'band_lock_params' })
  bandLockParams: {
    stopRatio: number;
    floorRatio: number;
    floorEnabled: boolean;
    ma5RequireDown: boolean;
  } | null;

  /**
   * phase_lock 额外参数（仅 phase_lock）；null = 全默认（存量行零漂移）。
   * 存入的是已量化（round-half-up 到 0.001）的网格点；runner 直接透传给核，核不再量化。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'phase_lock_params' })
  phaseLockParams: { initFactor: number; lockFactor: number; lookback: number } | null;

  /**
   * 迷你回测配置（资金/仓位/排序/熔断/成本）；null = 不跑回测（存量行零漂移）。
   * 扁平化单源（spec 03 §3.2）；后端适配层组装成引擎 PortfolioSimConfig。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'backtest_config' })
  backtestConfig: SignalTestBacktestConfig | null;

  @Column({ type: 'jsonb' })
  universe: SignalTestUniverse;

  @Column({ type: 'varchar', length: 8, name: 'date_start' })
  dateStart: string;

  @Column({ type: 'varchar', length: 8, name: 'date_end' })
  dateEnd: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
