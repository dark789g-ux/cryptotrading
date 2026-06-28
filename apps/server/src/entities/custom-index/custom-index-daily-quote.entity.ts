import { Column, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('custom_index_daily_quotes')
@Index(['customIndexId', 'tradeDate'])
export class CustomIndexDailyQuoteEntity {
  @PrimaryColumn({ name: 'custom_index_id', type: 'uuid' })
  customIndexId: string;

  @PrimaryColumn({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ type: 'double precision', nullable: true })
  open: number | null;

  @Column({ type: 'double precision', nullable: true })
  high: number | null;

  @Column({ type: 'double precision', nullable: true })
  low: number | null;

  @Column({ type: 'double precision', nullable: true })
  close: number | null;

  @Column({ name: 'pre_close', type: 'double precision', nullable: true })
  preClose: number | null;

  @Column({ type: 'double precision', nullable: true })
  change: number | null;

  @Column({ name: 'pct_change', type: 'double precision', nullable: true })
  pctChange: number | null;

  @Column({ name: 'vol_hand', type: 'double precision', nullable: true })
  volHand: number | null;

  @Column({ type: 'double precision', nullable: true })
  amount: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
