import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('money_flow_industries')
@Unique(['industry', 'tradeDate'])
export class MoneyFlowIndustryEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ length: 64 })
  industry: string;

  @Column({ name: 'pct_change', type: 'numeric', precision: 20, scale: 4, nullable: true })
  pctChange: string | null;

  @Column({ name: 'net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netAmount: string | null;

  @Column({ name: 'buy_lg_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyLgAmount: string | null;

  @Column({ name: 'buy_md_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyMdAmount: string | null;

  @Column({ name: 'buy_sm_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buySmAmount: string | null;

  @UpdateDateColumn({ name: 'updated_at' })
  updatedAt: Date;
}
