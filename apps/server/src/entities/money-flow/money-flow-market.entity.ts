import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('money_flow_market')
@Unique(['tradeDate'])
export class MoneyFlowMarketEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netAmount: string | null;

  @Column({ name: 'buy_lg_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyLgAmount: string | null;

  @Column({ name: 'buy_sm_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buySmAmount: string | null;

  @Column({ name: 'hk_net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  hkNetAmount: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
