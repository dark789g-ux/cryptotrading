import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('a_share_adj_factors')
@Unique(['tsCode', 'tradeDate'])
export class AShareAdjFactorEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code' })
  tsCode: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'adj_factor', type: 'numeric', precision: 30, scale: 10, nullable: true })
  adjFactor: string;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
