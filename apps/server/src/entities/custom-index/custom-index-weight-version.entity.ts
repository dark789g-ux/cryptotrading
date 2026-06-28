import {
  Column,
  CreateDateColumn,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
} from 'typeorm';
import type { CustomIndexWeightMethod } from './custom-index-definition.entity';

@Entity('custom_index_weight_versions')
@Unique(['customIndexId', 'effectiveDate'])
@Index('idx_custom_index_weight_versions_active', { synchronize: false })
export class CustomIndexWeightVersionEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'custom_index_id', type: 'uuid' })
  customIndexId: string;

  @Column({ name: 'effective_date', length: 8 })
  effectiveDate: string;

  @Column({ name: 'expire_date', length: 8, nullable: true })
  expireDate: string | null;

  @Column({ name: 'weight_method', length: 16 })
  weightMethod: CustomIndexWeightMethod;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;
}
