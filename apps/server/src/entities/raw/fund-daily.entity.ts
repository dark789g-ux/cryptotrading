import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ schema: 'raw', name: 'fund_daily' })
@Unique(['tsCode', 'tradeDate'])
@Index('idx_fund_daily_code', ['tsCode'])
@Index('idx_fund_daily_date', ['tradeDate'])
export class FundDailyEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'ts_code', length: 16 })
  tsCode: string;

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

  @Column({ name: 'change_val', type: 'numeric', precision: 30, scale: 10, nullable: true })
  changeVal: string;

  @Column({ name: 'pct_chg', type: 'numeric', precision: 30, scale: 10, nullable: true })
  pctChg: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  vol: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  amount: string;

  @Column({ name: 'adj_factor', type: 'numeric', precision: 20, scale: 6, nullable: true })
  adjFactor: string | null;

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

  @Column({ name: 'qfq_change_val', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqChangeVal: string;

  @Column({ name: 'qfq_pct_chg', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqPctChg: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
