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

  @Column({ type: 'varchar', length: 16, name: 'exit_mode' })
  exitMode: 'fixed_n' | 'strategy';

  @Column({ type: 'int', nullable: true, name: 'horizon_n' })
  horizonN: number | null;

  @Column({ type: 'jsonb', nullable: true, name: 'exit_conditions' })
  exitConditions: StrategyConditionItem[] | null;

  @Column({ type: 'int', nullable: true, name: 'max_hold' })
  maxHold: number | null;

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
