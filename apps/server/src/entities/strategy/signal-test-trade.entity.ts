import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { SignalTestRunEntity } from './signal-test-run.entity';

@Entity('signal_test_trade')
export class SignalTestTradeEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId: string;

  @Column({ type: 'varchar', length: 30, name: 'ts_code' })
  tsCode: string;

  @Column({ type: 'varchar', length: 8, name: 'signal_date' })
  signalDate: string;

  @Column({ type: 'varchar', length: 8, name: 'buy_date' })
  buyDate: string;

  @Column({ type: 'varchar', length: 8, name: 'exit_date' })
  exitDate: string;

  @Column({ type: 'numeric', name: 'buy_price' })
  buyPrice: string;

  @Column({ type: 'numeric', name: 'exit_price' })
  exitPrice: string;

  @Column({ type: 'numeric' })
  ret: string;

  @Column({ type: 'int', name: 'hold_days' })
  holdDays: number;

  // 列为 varchar(16) 无 DB CHECK；trailing_lock 出场新增 'stop'/'ma5_exit'（spec 03 §1.3，无需迁移）。
  // phase_lock 出场新增 'phase_lock_stop'/'phase_lock_ma5'（最长 15 字符 ≤ 16，新枚举值无需迁移）。
  @Column({ type: 'varchar', length: 16, name: 'exit_reason' })
  exitReason:
    | 'max_hold'
    | 'signal'
    | 'delist'
    | 'stop'
    | 'ma5_exit'
    | 'phase_lock_stop'
    | 'phase_lock_ma5';

  @ManyToOne(() => SignalTestRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: SignalTestRunEntity;
}
