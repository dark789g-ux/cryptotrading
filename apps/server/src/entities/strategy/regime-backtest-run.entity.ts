import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { RegimeStrategyConfigEntity } from './regime-strategy-config.entity';
import { NumericTransformer } from '../common/numeric.transformer';

export type RegimeBacktestConfigSnapshot = Record<string, unknown>;

export type RegimeBacktestRunStatus = 'pending' | 'running' | 'completed' | 'failed';

export type RegimeBacktestRunPhase = 'loading' | 'replaying' | 'writing' | null;

@Entity('regime_backtest_run')
export class RegimeBacktestRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', nullable: true, name: 'regime_config_id' })
  regimeConfigId: string | null;

  @ManyToOne(() => RegimeStrategyConfigEntity, { onDelete: 'SET NULL' })
  @JoinColumn({ name: 'regime_config_id' })
  regimeConfig: RegimeStrategyConfigEntity | null;

  @Column({ type: 'int', nullable: true, name: 'regime_config_version' })
  regimeConfigVersion: number | null;

  @Column({ type: 'varchar', length: 200 })
  name: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'jsonb' })
  config: RegimeBacktestConfigSnapshot;

  @Column({ type: 'varchar', length: 8, name: 'date_start' })
  dateStart: string;

  @Column({ type: 'varchar', length: 8, name: 'date_end' })
  dateEnd: string;

  @Column({ type: 'varchar', length: 20, default: 'pending' })
  status: RegimeBacktestRunStatus;

  @Column({ type: 'varchar', length: 20, nullable: true })
  phase: RegimeBacktestRunPhase;

  @Column({ type: 'int', default: 0, name: 'progress_done' })
  progressDone: number;

  @Column({ type: 'int', default: 0, name: 'progress_total' })
  progressTotal: number;

  @Column({ type: 'numeric', nullable: true, name: 'final_nav', transformer: new NumericTransformer() })
  finalNav: number | null;

  @Column({ type: 'numeric', nullable: true, name: 'total_ret', transformer: new NumericTransformer() })
  totalRet: number | null;

  @Column({ type: 'numeric', nullable: true, name: 'annual_ret', transformer: new NumericTransformer() })
  annualRet: number | null;

  @Column({ type: 'numeric', nullable: true, name: 'max_drawdown', transformer: new NumericTransformer() })
  maxDrawdown: number | null;

  @Column({ type: 'numeric', nullable: true, transformer: new NumericTransformer() })
  sharpe: number | null;

  @Column({ type: 'numeric', nullable: true, transformer: new NumericTransformer() })
  calmar: number | null;

  @Column({ type: 'numeric', nullable: true, name: 'daily_win_rate', transformer: new NumericTransformer() })
  dailyWinRate: number | null;

  @Column({ type: 'numeric', nullable: true, name: 'daily_kelly', transformer: new NumericTransformer() })
  dailyKelly: number | null;

  @Column({ type: 'int', nullable: true, name: 'n_taken' })
  nTaken: number | null;

  @Column({ type: 'int', nullable: true, name: 'n_skipped' })
  nSkipped: number | null;

  @Column({ type: 'numeric', nullable: true, name: 'total_costs', transformer: new NumericTransformer() })
  totalCosts: number | null;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;
}
