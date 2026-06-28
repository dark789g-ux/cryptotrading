import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  UpdateDateColumn,
} from 'typeorm';

export type CustomIndexType = 'price' | 'total_return';
export type CustomIndexWeightMethod = 'equal' | 'float_mv' | 'custom';
export type CustomIndexStatus = 'pending' | 'computing' | 'ready' | 'failed';

@Entity('custom_index_definitions')
@Index(['userId', 'updatedAt'])
@Index('idx_custom_index_definitions_status_pending', { synchronize: false })
export class CustomIndexDefinitionEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'user_id', type: 'varchar', length: 36 })
  userId: string;

  @Column({ name: 'ts_code', length: 24, unique: true })
  tsCode: string;

  @Column({ length: 100 })
  name: string;

  @Column({ type: 'text', nullable: true })
  description: string | null;

  @Column({ name: 'index_type', length: 16 })
  indexType: CustomIndexType;

  @Column({ name: 'base_date', length: 8 })
  baseDate: string;

  @Column({ name: 'base_point', type: 'numeric', precision: 20, scale: 4, default: 1000 })
  basePoint: string;

  @Column({ name: 'weight_method', length: 16 })
  weightMethod: CustomIndexWeightMethod;

  @Column({ length: 16, default: 'pending' })
  status: CustomIndexStatus;

  @Column({ name: 'compute_progress', type: 'smallint', nullable: true })
  computeProgress: number | null;

  @Column({ name: 'compute_stage', length: 64, nullable: true })
  computeStage: string | null;

  @Column({ name: 'latest_job_id', type: 'uuid', nullable: true })
  latestJobId: string | null;

  @Column({ name: 'last_error', type: 'text', nullable: true })
  lastError: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
