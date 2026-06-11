import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';

/** 组合模拟 config 快照：完整 sources / 初始资金 / 解析后费率 / 锚点模式 */
export interface PortfolioSimConfig {
  sources: unknown[];
  initialCapital: number;
  /** 解析后费率（commission / slippage / stampDuty 等的归一化快照） */
  fees: Record<string, unknown>;
  anchorMode: string;
  [key: string]: unknown;
}

/** 锚点自校验结果（官方 vs 重放 Kelly / 胜率 / 样本数对齐） */
export interface PortfolioSimAnchorCheck {
  pass: boolean;
  kellyOfficial: number;
  kellyReplayed: number;
  winOfficial: number;
  winReplayed: number;
  nOfficial: number;
  nReplayed: number;
}

@Entity('portfolio_sim_run')
export class PortfolioSimRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @Column({ type: 'jsonb' })
  config: PortfolioSimConfig;

  @Column({ type: 'varchar', length: 16, default: 'pending' })
  status: 'pending' | 'running' | 'success' | 'failed';

  @Column({ type: 'varchar', length: 16, nullable: true })
  phase: 'loading' | 'replaying' | 'writing' | null;

  @Column({ type: 'int', default: 0, name: 'progress_done' })
  progressDone: number;

  @Column({ type: 'int', default: 0, name: 'progress_total' })
  progressTotal: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

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

  @Column({ type: 'jsonb', nullable: true, name: 'anchor_check' })
  anchorCheck: PortfolioSimAnchorCheck | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;
}
