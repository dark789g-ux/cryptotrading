import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
  Index,
} from 'typeorm';
import { SignalTestRunEntity } from './signal-test-run.entity';

/**
 * signal_test_equity：迷你回测逐日净值曲线（spec 03 §3.4）。
 *
 * 映射 EngineDailyRow 的子集（不存 strategyExposure 单源冗余、不存 fills）。
 * PK 用自有 uuid（不跟随 portfolio_sim_daily 的 bigint 自增）。
 * 重跑幂等：runner 写 equity 前先 DELETE WHERE run_id=$1（与 trade 重跑清理同事务）。
 */
@Entity('signal_test_equity')
@Index('uq_signal_test_equity_run_date', ['runId', 'tradeDate'], {
  unique: true,
})
export class SignalTestEquityEntity {
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

  // Σmv / nav
  @Column({ type: 'numeric' })
  exposure: string;

  @Column({ type: 'int', name: 'position_count' })
  positionCount: number;

  @ManyToOne(() => SignalTestRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: SignalTestRunEntity;
}
