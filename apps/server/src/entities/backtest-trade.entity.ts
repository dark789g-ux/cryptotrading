import {
  Entity, Column, PrimaryGeneratedColumn,
  ManyToOne, JoinColumn,
} from 'typeorm';
import { BacktestRunEntity } from './backtest-run.entity';

@Entity('backtest_trades')
export class BacktestTradeEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'run_id' })
  runId: string;

  @ManyToOne(() => BacktestRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: BacktestRunEntity;

  @Column()
  symbol: string;

  @Column({ name: 'entry_time', type: 'timestamptz', nullable: true })
  entryTime: Date;

  @Column({ name: 'entry_price', type: 'double precision', nullable: true })
  entryPrice: number;

  @Column({ name: 'exit_time', type: 'timestamptz', nullable: true })
  exitTime: Date;

  @Column({ name: 'exit_price', type: 'double precision', nullable: true })
  exitPrice: number;

  @Column({ type: 'double precision', nullable: true })
  pnl: number;

  @Column({ name: 'pnl_pct', type: 'double precision', nullable: true })
  pnlPct: number;

  @Column({ name: 'hold_bars', type: 'integer', nullable: true })
  holdBars: number;
}
