import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { RegimeBacktestRunEntity } from './regime-backtest-run.entity';

@Entity('regime_backtest_trade')
@Index('idx_regime_backtest_trade_run_buy_date', ['runId', 'buyDate'])
export class RegimeBacktestTradeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId: string;

  @Column({ type: 'varchar', length: 8, name: 'signal_date' })
  signalDate: string;

  @Column({ type: 'varchar', length: 8, name: 'buy_date' })
  buyDate: string;

  @Column({ type: 'varchar', length: 8, nullable: true, name: 'exit_date' })
  exitDate: string | null;

  @Column({ type: 'varchar', length: 20, name: 'ts_code' })
  tsCode: string;

  @Column({ type: 'varchar', length: 10 })
  regime: string;

  @Column({ type: 'varchar', length: 20, name: 'exit_mode' })
  exitMode: string;

  @Column({ type: 'varchar', length: 10 })
  status: 'taken' | 'skipped';

  @Column({ type: 'varchar', length: 20, nullable: true, name: 'skip_reason' })
  skipReason: string | null;

  @Column({ type: 'varchar', length: 50, nullable: true, name: 'exit_reason' })
  exitReason: string | null;

  @Column({ type: 'numeric', nullable: true })
  ret: string | null;

  @Column({ type: 'numeric', nullable: true })
  alloc: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'costs_paid' })
  costsPaid: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'realized_ret_net' })
  realizedRetNet: string | null;

  @Column({ type: 'int', nullable: true })
  rank: number | null;

  @Column({ type: 'varchar', length: 32, nullable: true, name: 'rank_field' })
  rankField: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'rank_value' })
  rankValue: string | null;

  @ManyToOne(() => RegimeBacktestRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: RegimeBacktestRunEntity;
}
