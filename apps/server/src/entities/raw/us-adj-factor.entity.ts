import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

/**
 * raw.us_adj_factor — 美股派生复权因子（adj_factor = qfq_close / raw_close，见 spec 02/03）。
 */
@Entity({ schema: 'raw', name: 'us_adj_factor' })
@Unique(['ticker', 'tradeDate'])
export class UsAdjFactorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column()
  ticker: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'adj_factor', type: 'numeric', precision: 30, scale: 10, nullable: true })
  adjFactor: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
