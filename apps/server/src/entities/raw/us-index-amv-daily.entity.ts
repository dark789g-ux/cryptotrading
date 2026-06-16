import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * raw.us_index_amv_daily — 美股指数活跃市值（AMV）输出表。
 *
 * 镜像 A 股 public.industry_amv_daily（真 DB `\d` 核验），把 ts_code → index_code，schema 放 raw
 * （与 raw.us_index_daily 等 us_* 表一致）。
 *
 * 列语义：四价（amv_open/high/low/close）+ MACD 三列（amv_dif/dea/macd）+ amv_zdf（涨跌幅，可空）
 * + signal（-1/0/1，NOT NULL）+ member_count（当日有效成分数）。
 * amv_* 双精度可空（schema 容错；异常日整行丢弃不落库，故实际落库行 amv_close 恒非空）。
 *
 * 见 docs/superpowers/specs/2026-06-16-us-index-amv-design/02-data-model.md §1。
 */
@Entity({ schema: 'raw', name: 'us_index_amv_daily' })
@Unique('uq_us_index_amv_daily', ['indexCode', 'tradeDate'])
export class UsIndexAmvDailyEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'index_code', length: 16 })
  indexCode: string;

  @Index()
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

  @Column({ name: 'signal', type: 'smallint' })
  signal: number;

  @Column({ name: 'member_count', type: 'integer', nullable: true })
  memberCount: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
