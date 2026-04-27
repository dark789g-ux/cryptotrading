import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('a_share_sync_states')
export class AShareSyncStateEntity {
  @PrimaryColumn({ name: 'ts_code' })
  tsCode: string;

  @Column({ name: 'qfq_dirty_from_date', length: 8, nullable: true })
  qfqDirtyFromDate: string;

  @Column({ name: 'indicator_dirty_from_date', length: 8, nullable: true })
  indicatorDirtyFromDate: string;

  @Column({ name: 'indicator_calculated_to_date', length: 8, nullable: true })
  indicatorCalculatedToDate: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
