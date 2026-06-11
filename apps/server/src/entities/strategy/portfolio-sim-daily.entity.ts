import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { PortfolioSimRunEntity } from './portfolio-sim-run.entity';

@Entity('portfolio_sim_daily')
@Index('uq_portfolio_sim_daily_run_date', ['runId', 'tradeDate'], {
  unique: true,
})
export class PortfolioSimDailyEntity {
  // bigserial PK：JS 侧以 string 取回，防 bigint 精度丢失
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId: string;

  @Column({ type: 'varchar', length: 8, name: 'trade_date' })
  tradeDate: string;

  @Column({ type: 'numeric' })
  nav: string;

  @Column({ type: 'numeric' })
  cash: string;

  @Column({ type: 'numeric', name: 'daily_ret' })
  dailyRet: string;

  @Column({ type: 'numeric' })
  exposure: string;

  @Column({ type: 'int', name: 'position_count' })
  positionCount: number;

  @Column({ type: 'jsonb', name: 'strategy_exposure' })
  strategyExposure: Record<string, unknown>;

  @ManyToOne(() => PortfolioSimRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: PortfolioSimRunEntity;
}
