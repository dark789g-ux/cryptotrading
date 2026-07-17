import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
  CreateDateColumn,
} from 'typeorm';
import { RegimeBacktestRunEntity } from './regime-backtest-run.entity';
import { NumericTransformer } from '../common/numeric.transformer';

@Entity('regime_backtest_daily_log')
@Index('uq_regime_backtest_daily_log_run_date', ['runId', 'tradeDate'], {
  unique: true,
})
export class RegimeBacktestDailyLogEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId: string;

  @Column({ type: 'varchar', length: 8, name: 'trade_date' })
  tradeDate: string;

  @Column({ type: 'numeric', transformer: new NumericTransformer() })
  nav: number;

  @Column({ type: 'numeric', transformer: new NumericTransformer() })
  cash: number;

  @Column({ type: 'varchar', length: 16 })
  regime: string;

  @Column({ type: 'varchar', length: 24, name: 'frozen_reason', nullable: true })
  frozenReason: string | null;

  @Column({ type: 'varchar', length: 12, name: 'trade_phase', nullable: true })
  tradePhase: string | null;

  @Column({ type: 'jsonb', name: 'entries_json', default: () => "'[]'" })
  entriesJson: unknown;

  @Column({ type: 'jsonb', name: 'exits_json', default: () => "'[]'" })
  exitsJson: unknown;

  @Column({ type: 'jsonb', name: 'open_symbols_json', default: () => "'[]'" })
  openSymbolsJson: unknown;

  @Column({ type: 'boolean', name: 'in_cooldown', default: false })
  inCooldown: boolean;

  @Column({ type: 'int', name: 'cooldown_duration', nullable: true })
  cooldownDuration: number | null;

  @Column({ type: 'int', name: 'cooldown_remaining', nullable: true })
  cooldownRemaining: number | null;

  @Column({ type: 'int', name: 'consec_losses', default: 0 })
  consecLosses: number;

  @CreateDateColumn({ type: 'timestamptz', name: 'created_at' })
  createdAt: Date;

  @ManyToOne(() => RegimeBacktestRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: RegimeBacktestRunEntity;
}
