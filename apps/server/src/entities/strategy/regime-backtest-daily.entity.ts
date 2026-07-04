import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { RegimeBacktestRunEntity } from './regime-backtest-run.entity';

@Entity('regime_backtest_daily')
@Index('uq_regime_backtest_daily_run_date', ['runId', 'tradeDate'], {
  unique: true,
})
export class RegimeBacktestDailyEntity {
  @PrimaryGeneratedColumn('uuid')
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

  @ManyToOne(() => RegimeBacktestRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: RegimeBacktestRunEntity;
}
