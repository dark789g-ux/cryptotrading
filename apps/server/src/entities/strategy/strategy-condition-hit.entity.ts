import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  ManyToOne,
  JoinColumn,
} from 'typeorm';
import { StrategyConditionRunEntity } from './strategy-condition-run.entity';

@Entity('strategy_condition_hits')
export class StrategyConditionHitEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'uuid', name: 'run_id' })
  runId: string;

  @Column({ type: 'varchar', length: 30, name: 'ts_code' })
  tsCode: string;

  @Column({ type: 'varchar', length: 100, nullable: true })
  name: string | null;

  @Column({ type: 'jsonb', default: '[]', name: 'matched_conditions' })
  matchedConditions: string[];

  @ManyToOne(() => StrategyConditionRunEntity, { onDelete: 'CASCADE' })
  @JoinColumn({ name: 'run_id' })
  run: StrategyConditionRunEntity;
}
