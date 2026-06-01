import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 个股活跃市值（AMV）日线宽表。spec §5。
 * 量 = raw.daily_quote.amount（千元，计算时 ×1000），价 = 前复权 qfq OHLC。
 */
@Entity('stock_amv_daily')
@Unique('uq_stock_amv_daily_code_date', ['tsCode', 'tradeDate'])
@Index('idx_stock_amv_daily_code_date', ['tsCode', 'tradeDate'])
@Index('idx_stock_amv_daily_date_signal', ['tradeDate', 'signal'])
export class StockAmvDailyEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'ts_code' })
  tsCode: string;

  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'amv_open', type: 'double precision', nullable: true })
  amvOpen: number | null;

  @Column({ name: 'amv_high', type: 'double precision', nullable: true })
  amvHigh: number | null;

  @Column({ name: 'amv_low', type: 'double precision', nullable: true })
  amvLow: number | null;

  @Column({ name: 'amv_close', type: 'double precision', nullable: true })
  amvClose: number | null;

  @Column({ name: 'amv_dif', type: 'double precision', nullable: true })
  amvDif: number | null;

  @Column({ name: 'amv_dea', type: 'double precision', nullable: true })
  amvDea: number | null;

  /** MACD 柱 = 2×(DIF-DEA) */
  @Column({ name: 'amv_macd', type: 'double precision', nullable: true })
  amvMacd: number | null;

  /** 涨跌幅（仅展示，分母≤0 落 NULL） */
  @Column({ name: 'amv_zdf', type: 'double precision', nullable: true })
  amvZdf: number | null;

  /** 三态信号：-1 空头 / 0 中性 / +1 多头（CHECK 约束在 migration） */
  @Column({ type: 'smallint' })
  signal: number;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
