import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * raw.us_index_constituent — 美股指数成分名单表。
 *
 * seed 101 只 .NDX 成分（Wikipedia 全集），weight_pct 用 stockanalysis 可匹配的 25 只，余 NULL。
 * 成分 ticker 不写入 raw.us_symbol（无外键，零污染美股 Tab）。
 *
 * 见 docs/superpowers/specs/2026-06-16-us-index-amv-design/02-data-model.md §2。
 */
@Entity({ schema: 'raw', name: 'us_index_constituent' })
@Unique('uq_us_index_constituent', ['indexCode', 'ticker'])
export class UsIndexConstituentEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'index_code', length: 16 })
  indexCode: string;

  @Column({ name: 'ticker', length: 16 })
  ticker: string;

  /** 仅 top-25 有值，余 NULL（裸 Σ 不用，仅参考） */
  @Column({ name: 'weight_pct', type: 'double precision', nullable: true })
  weightPct: number | null;

  @Column({ name: 'name', type: 'varchar', nullable: true })
  name: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
