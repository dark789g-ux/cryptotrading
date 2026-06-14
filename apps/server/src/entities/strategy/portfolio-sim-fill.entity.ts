import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { PortfolioSimRunEntity } from './portfolio-sim-run.entity';
import { SkipReason } from '../../strategy-conditions/portfolio-sim/portfolio-sim.types';

@Entity('portfolio_sim_fill')
@Index('idx_portfolio_sim_fill_run_status', ['runId', 'status'])
@Index('idx_portfolio_sim_fill_run_buy_date', ['runId', 'buyDate'])
export class PortfolioSimFillEntity {
  // bigserial PK：JS 侧以 string 取回，防 bigint 精度丢失
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId: string;

  @Column({ type: 'uuid', name: 'source_run_id' })
  sourceRunId: string;

  @Column({ type: 'varchar', length: 50, name: 'source_label' })
  sourceLabel: string;

  @Column({ type: 'varchar', length: 30, name: 'ts_code' })
  tsCode: string;

  @Column({ type: 'varchar', length: 8, name: 'signal_date' })
  signalDate: string;

  @Column({ type: 'varchar', length: 8, name: 'buy_date' })
  buyDate: string;

  @Column({ type: 'varchar', length: 8 })
  status: 'taken' | 'skipped';

  // skip_reason 列已是 varchar(16)，足以容纳新增 cooldown/drawdown_halt/sized_out（最长 13 字符）；
  // 此处类型复用 SkipReason 联合，避免与引擎契约脱节（无需 migration，列宽不变）。
  @Column({ type: 'varchar', length: 16, nullable: true, name: 'skip_reason' })
  skipReason: SkipReason | null;

  @Column({ type: 'varchar', length: 16, nullable: true, name: 'rank_field' })
  rankField: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'rank_value' })
  rankValue: string | null;

  // composite 综合分（单因子=该因子值；none=null）。numeric 列 JS 侧以 string 取回防精度，
  // 沿用 rank_value/alloc 模式。老 run 为 NULL → 详情降级。
  @Column({ type: 'numeric', nullable: true, name: 'rank_score' })
  rankScore: string | null;

  // 逐因子原始值 {factorKey: value|null, ...}（taken/skipped 都写，含熔断冻结 skip 的笔）。
  // 仅展示，不进 WHERE/ORDER。老 run 为 NULL → 详情降级。
  @Column({ type: 'jsonb', nullable: true, name: 'factor_values' })
  factorValues: Record<string, number | null> | null;

  @Column({ type: 'numeric', nullable: true, name: 'weight_entry' })
  weightEntry: string | null;

  @Column({ type: 'numeric', nullable: true })
  alloc: string | null;

  @Column({ type: 'varchar', length: 8, nullable: true, name: 'exit_date' })
  exitDate: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'realized_ret_net' })
  realizedRetNet: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'costs_paid' })
  costsPaid: string | null;

  @ManyToOne(() => PortfolioSimRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: PortfolioSimRunEntity;
}
