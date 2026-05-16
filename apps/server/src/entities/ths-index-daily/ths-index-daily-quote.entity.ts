import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 同花顺指数日线行情（Tushare ths_daily）。
 * - vol 单位为「手」，与 Tushare 原值一致（不换算）
 * - total_mv / float_mv 单位为「万元」，由 Tushare 原值「元」÷ 10000 落库
 *
 * Tushare ths_daily 没有 amount 字段，本表不造假。
 */
@Entity('ths_index_daily_quotes')
@Unique(['tsCode', 'tradeDate'])
@Index('idx_ths_index_daily_quotes_tscode_tradedate', ['tsCode', 'tradeDate'])
export class ThsIndexDailyQuoteEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code', length: 20 })
  tsCode: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
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

  /** 成交量，单位「手」（Tushare 原始单位，不换算） */
  @Column({ name: 'vol_hand', type: 'double precision', nullable: true })
  volHand: number | null;

  /** 总市值，单位「万元」（Tushare 原值「元」÷ 10000） */
  @Column({ name: 'total_mv_wan', type: 'numeric', precision: 20, scale: 4, nullable: true })
  totalMvWan: string | null;

  /** 流通市值，单位「万元」（Tushare 原值「元」÷ 10000） */
  @Column({ name: 'float_mv_wan', type: 'numeric', precision: 20, scale: 4, nullable: true })
  floatMvWan: string | null;

  @Column({ name: 'turnover_rate', type: 'double precision', nullable: true })
  turnoverRate: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
