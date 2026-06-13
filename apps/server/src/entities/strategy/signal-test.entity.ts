import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
} from 'typeorm';
import { StrategyConditionItem } from './strategy-condition.entity';

export interface SignalTestUniverse {
  type: 'all' | 'list';
  tsCodes?: string[];
}

@Entity('signal_test')
export class SignalTestEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'jsonb', name: 'buy_conditions' })
  buyConditions: StrategyConditionItem[];

  // 列为 varchar(16) 无 DB CHECK；trailing_lock 波段跟踪止损出场新增（spec，无需迁移）。
  @Column({ type: 'varchar', length: 16, name: 'exit_mode' })
  exitMode: 'fixed_n' | 'strategy' | 'trailing_lock';

  @Column({ type: 'int', nullable: true, name: 'horizon_n' })
  horizonN: number | null;

  @Column({ type: 'jsonb', nullable: true, name: 'exit_conditions' })
  exitConditions: StrategyConditionItem[] | null;

  @Column({ type: 'int', nullable: true, name: 'max_hold' })
  maxHold: number | null;

  /**
   * 波段跟踪止损额外参数（仅 trailing_lock）；null = 全默认（存量行零漂移）。
   * 存入的是已量化（round-half-up 到 0.001）的网格点 ratio——runner 直接透传给核，核不再量化。
   */
  @Column({ type: 'jsonb', nullable: true, name: 'band_lock_params' })
  bandLockParams: {
    stopRatio: number;
    floorRatio: number;
    floorEnabled: boolean;
    ma5RequireDown: boolean;
  } | null;

  @Column({ type: 'jsonb' })
  universe: SignalTestUniverse;

  @Column({ type: 'varchar', length: 8, name: 'date_start' })
  dateStart: string;

  @Column({ type: 'varchar', length: 8, name: 'date_end' })
  dateEnd: string;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
