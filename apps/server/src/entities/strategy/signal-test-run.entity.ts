import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { SignalTestEntity } from './signal-test.entity';

@Entity('signal_test_run')
export class SignalTestRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'test_id' })
  testId: string;

  @Column({ type: 'varchar', length: 16, default: 'running' })
  status: 'running' | 'completed' | 'failed';

  @Column({ type: 'int', default: 0, name: 'progress_scanned' })
  progressScanned: number;

  @Column({ type: 'int', default: 0, name: 'progress_total' })
  progressTotal: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @Column({ type: 'int', nullable: true, name: 'sample_count' })
  sampleCount: number | null;

  @Column({ type: 'numeric', nullable: true, name: 'win_rate' })
  winRate: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'avg_win' })
  avgWin: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'avg_loss' })
  avgLoss: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'payoff_ratio' })
  payoffRatio: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'profit_factor' })
  profitFactor: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'kelly_f' })
  kellyF: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'avg_hold_days' })
  avgHoldDays: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'worst_trade_ret' })
  worstTradeRet: string | null;

  @Column({ type: 'int', default: 0, name: 'filtered_count' })
  filteredCount: number;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;

  @ManyToOne(() => SignalTestEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'test_id' })
  test: SignalTestEntity;
}
