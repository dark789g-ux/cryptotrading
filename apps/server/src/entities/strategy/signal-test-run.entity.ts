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

  // 'replaying' = 资金账户层（迷你回测）引擎回放阶段（spec 02 §2.6，varchar(16) 无 CHECK，无需迁移）。
  @Column({ type: 'varchar', length: 16, nullable: true, name: 'phase' })
  phase: 'scanning' | 'simulating' | 'writing' | 'replaying' | null;

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

  @Column({ type: 'numeric', nullable: true, name: 'best_trade_ret' })
  bestTradeRet: string | null;

  // ---- 迷你回测层指标（spec 03 §3.3，均 nullable）----
  // null = 该 run 未跑回测层（与 signal_test.backtest_config IS NULL 对应）。
  // 映射 EngineSummary；与上方信号质量聚合列叠加共存（D2 决策）。

  @Column({ type: 'numeric', nullable: true, name: 'final_nav' })
  finalNav: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'total_ret' })
  totalRet: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'annual_ret' })
  annualRet: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'max_drawdown' })
  maxDrawdown: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'sharpe' })
  sharpe: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'calmar' })
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
