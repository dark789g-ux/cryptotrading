import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * raw.us_daily_quote — 美股不复权日线 + 派生前复权 qfq_*。
 *
 * AkShare stock_us_daily(adjust="") 给 open/high/low/close/volume（无 pre_close/amount）；
 * pre_close/pct_chg 派生，qfq_* 由 raw × adj_factor / 最新 factor 算（见 spec 03/04）。
 */
@Entity({ schema: 'raw', name: 'us_daily_quote' })
@Unique(['ticker', 'tradeDate'])
export class UsDailyQuoteEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column()
  ticker: string;

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

  @Column({ name: 'pct_chg', type: 'numeric', precision: 30, scale: 10, nullable: true })
  pctChg: string;

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  volume: string;

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

  @Column({ name: 'qfq_pct_chg', type: 'numeric', precision: 30, scale: 10, nullable: true })
  qfqPctChg: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
