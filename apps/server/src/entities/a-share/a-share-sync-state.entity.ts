import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('a_share_sync_states')
export class AShareSyncStateEntity {
  @PrimaryColumn({ name: 'ts_code' })
  tsCode: string;

  @Column({ name: 'qfq_dirty_from_date', length: 8, nullable: true })
  qfqDirtyFromDate: string;

  @Column({ name: 'indicator_dirty_from_date', length: 8, nullable: true })
  indicatorDirtyFromDate: string;

  @Column({ name: 'signal_rolling_dirty_from_date', length: 8, nullable: true })
  signalRollingDirtyFromDate: string;

  @Column({ name: 'indicator_calculated_to_date', length: 8, nullable: true })
  indicatorCalculatedToDate: string;

  /** PR-6③-a：AMV 脏起点（daily_quote / 复权变动传导）；dirty 重算后清 NULL。 */
  @Column({ name: 'amv_dirty_from_date', length: 8, nullable: true })
  amvDirtyFromDate: string;

  /** PR-6③-a：AMV 已算到的最新交易日。 */
  @Column({ name: 'amv_calculated_to_date', length: 8, nullable: true })
  amvCalculatedToDate: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
