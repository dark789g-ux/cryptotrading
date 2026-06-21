import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  UpdateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { UserEntity } from '../../users/entities/user.entity';

export type TargetType = 'crypto' | 'a-share';

export interface StrategyConditionItem {
  field: string;
  operator: 'gt' | 'gte' | 'lt' | 'lte' | 'eq' | 'neq' | 'cross_above' | 'cross_below';
  value?: number;
  compareField?: string;
  compareMode?: 'field' | 'value';
  /** 自定义 KDJ 参数（N/M1/M2）；仅当 field/compareField 为 KDJ 字段时有意义；缺省视为 9/3/3。 */
  kdjParams?: { n: number; m1: number; m2: number };
}

@Entity('strategy_conditions')
export class StrategyConditionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'varchar', length: 100 })
  name: string;

  @Column({ type: 'varchar', length: 36, name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 20, name: 'target_type' })
  targetType: TargetType;

  @Column({ type: 'jsonb', default: '[]' })
  conditions: StrategyConditionItem[];

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;

  @Column({ type: 'uuid', nullable: true, name: 'last_run_id' })
  lastRunId: string | null;

  @ManyToOne(() => UserEntity)
  @JoinColumn({ name: 'user_id' })
  user: UserEntity;
}
