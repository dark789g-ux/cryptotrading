import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * raw.us_index_daily — 美股指数不复权日线（无 qfq、无 adj_factor，比个股简单）。
 *
 * AkShare 指数接口给 open/high/low/close/volume（amount 恒 0 丢弃）；
 * 无 pre_close/pct_chg（接口不给，v1 不派生），见 spec 2026-06-16-us-index-subtab-design/01。
 */
@Entity({ schema: 'raw', name: 'us_index_daily' })
@Unique(['indexCode', 'tradeDate'])
export class UsIndexDailyQuoteEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'index_code' })
  indexCode: string;

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

  @Column({ type: 'numeric', precision: 30, scale: 10, nullable: true })
  volume: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
