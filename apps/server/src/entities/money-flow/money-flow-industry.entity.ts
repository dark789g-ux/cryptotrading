import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('money_flow_industries')
@Unique(['tsCode', 'tradeDate'])
export class MoneyFlowIndustryEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'ts_code', length: 16 })
  tsCode: string;

  @Column({ length: 64 })
  industry: string;

  @Column({ name: 'pct_change', type: 'numeric', precision: 20, scale: 4, nullable: true })
  pctChange: string | null;

  @Column({ name: 'net_buy_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netBuyAmount: string | null;

  @Column({ name: 'net_sell_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netSellAmount: string | null;

  @Column({ name: 'net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netAmount: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
