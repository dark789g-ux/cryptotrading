import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { StrategyConditionEntity } from './strategy-condition.entity';

@Entity('strategy_condition_runs')
export class StrategyConditionRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'condition_id' })
  conditionId: string;

  @Column({ type: 'varchar', length: 36, name: 'user_id' })
  userId: string;

  @Column({ type: 'varchar', length: 20, default: 'running' })
  status: 'running' | 'completed' | 'failed';

  @Column({ type: 'int', default: 0, name: 'progress_scanned' })
  progressScanned: number;

  @Column({ type: 'int', default: 0, name: 'progress_total' })
  progressTotal: number;

  @Column({ type: 'int', default: 0, name: 'total_hits' })
  totalHits: number;

  @Column({ type: 'text', nullable: true, name: 'error_message' })
  errorMessage: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'timestamptz', nullable: true, name: 'completed_at' })
  completedAt: Date | null;

  @ManyToOne(() => StrategyConditionEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'condition_id' })
  condition: StrategyConditionEntity;
}
