import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 申万行业指数（.SI）活跃市值（AMV）日线宽表。
 * 量 = index_member 成分股 raw.daily_quote.amount 之和（×1000），价 = index_daily_quotes（category=sw）OHLC。
 */
@Entity('sw_amv_daily')
@Unique('uq_sw_amv_daily_code_date', ['tsCode', 'tradeDate'])
@Index('idx_sw_amv_daily_code_date', ['tsCode', 'tradeDate'])
@Index('idx_sw_amv_daily_date_signal', ['tradeDate', 'signal'])
export class SwAmvDailyEntity {
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

  @Column({ name: 'amv_macd', type: 'double precision', nullable: true })
  amvMacd: number | null;

  @Column({ name: 'amv_zdf', type: 'double precision', nullable: true })
  amvZdf: number | null;

  @Column({ type: 'smallint' })
  signal: number;

  @Column({ name: 'member_count', type: 'integer', nullable: true })
  memberCount: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
