import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * 个股 AMV streaming 递推状态 checkpoint（镜像 raw.indicator_calc_state）。
 *
 * PR-6③-a：AMV dirty 续算的 seed / 快照。按 (tsCode, tradeDate) 唯一，稀疏写入
 * （每 N 行一 checkpoint）。续算时取 trade_date < dirtyFrom 的最后一行作 seed。
 */
@Entity({ schema: 'raw', name: 'amv_calc_state' })
@Unique(['tsCode', 'tradeDate'])
export class AmvCalcStateEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code' })
  tsCode: string;

  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ type: 'jsonb' })
  state: Record<string, unknown>;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
