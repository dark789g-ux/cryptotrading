import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 概念板块（同花顺 type='N' 指数）活跃市值（AMV）日线宽表。
 * 列定义与 industry-amv-daily.entity.ts 完全一致（同一套 AMV 双 join 算法的产物），
 * 只是按 type 物理隔离到独立表（方案 B 双表）。
 * 量 = 成分股 raw.daily_quote.amount 之和（×1000），价 = ths_index_daily_quotes 指数点位 OHLC。
 * member_count = 当日有 amount 的成分股数（完整性诊断）。
 */
@Entity('concept_amv_daily')
@Unique('uq_concept_amv_daily_code_date', ['tsCode', 'tradeDate'])
@Index('idx_concept_amv_daily_code_date', ['tsCode', 'tradeDate'])
@Index('idx_concept_amv_daily_date_signal', ['tradeDate', 'signal'])
export class ConceptAmvDailyEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  /** 同花顺概念指数代码（.TI，type='N'） */
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

  /** 当日有 amount 的成分股数（完整性诊断） */
  @Column({ name: 'member_count', type: 'integer', nullable: true })
  memberCount: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
