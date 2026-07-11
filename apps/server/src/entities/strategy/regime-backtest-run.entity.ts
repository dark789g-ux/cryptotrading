import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { RegimeStrategyConfigEntity } from './regime-strategy-config.entity';

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

  @Column({ type: 'numeric', nullable: true, name: 'final_nav' })
  finalNav: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'total_ret' })
  totalRet: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'annual_ret' })
  annualRet: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'max_drawdown' })
  maxDrawdown: string | null;

  @Column({ type: 'numeric', nullable: true })
  sharpe: string | null;

  @Column({ type: 'numeric', nullable: true })
  calmar: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'daily_win_rate' })
  dailyWinRate: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'daily_kelly' })
  dailyKelly: string | null;

  @Column({ type: 'int', nullable: true, name: 'n_taken' })
  nTaken: number | null;

  @Column({ type: 'int', nullable: true, name: 'n_skipped' })
  nSkipped: number | null;

  @Column({ type: 'numeric', nullable: true, name: 'total_costs' })
  totalCosts: string | null;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;
}
