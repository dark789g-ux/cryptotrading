import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('a_share_daily_quotes')
@Unique(['tsCode', 'tradeDate'])
export class AShareDailyQuoteEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code' })
  tsCode: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  open: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  high: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  low: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  close: string;

  @Column({ name: 'pre_close', type: 'numeric', precision: 30, scale: 10, nullable: true })
  preClose: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  change: string;

  @Column({ name: 'pct_chg', type: 'numeric', precision: 30, scale: 10, nullable: true })
  pctChg: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  vol: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  amount: string;

  @Column({ name: 'qfq_open', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqOpen: string;

  @Column({ name: 'qfq_high', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqHigh: string;

  @Column({ name: 'qfq_low', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqLow: string;

  @Column({ name: 'qfq_close', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqClose: string;

  @Column({ name: 'qfq_pre_close', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqPreClose: string;

  @Column({ name: 'qfq_change', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqChange: string;

  @Column({ name: 'qfq_pct_chg', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqPctChg: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
