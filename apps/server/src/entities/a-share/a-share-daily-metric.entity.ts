import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('a_share_daily_metrics')
@Unique(['tsCode', 'tradeDate'])
export class AShareDailyMetricEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code' })
  tsCode: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'turnover_rate', type: 'numeric', precision: 30, scale: 10, nullable: true })
  turnoverRate: string;

  @Column({ name: 'volume_ratio', type: 'numeric', precision: 30, scale: 10, nullable: true })
  volumeRatio: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  pe: string;

  @Column({ name: 'pe_ttm', type: 'numeric', precision: 30, scale: 10, nullable: true })
  peTtm: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  pb: string;

  @Column({ name: 'total_mv', type: 'numeric', precision: 30, scale: 10, nullable: true })
  totalMv: string;

  @Column({ name: 'circ_mv', type: 'numeric', precision: 30, scale: 10, nullable: true })
  circMv: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
