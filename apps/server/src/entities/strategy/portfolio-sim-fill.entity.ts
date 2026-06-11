import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { PortfolioSimRunEntity } from './portfolio-sim-run.entity';

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

  @Column({ type: 'varchar', length: 16, nullable: true, name: 'skip_reason' })
  skipReason:
    | 'already_held'
    | 'slots_full'
    | 'exposure_cap'
    | 'cash_short'
    | null;

  @Column({ type: 'varchar', length: 16, nullable: true, name: 'rank_field' })
  rankField: string | null;

  @Column({ type: 'numeric', nullable: true, name: 'rank_value' })
  rankValue: string | null;

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
