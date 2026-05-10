import { Column, Entity, Index, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity('money_flow_stocks')
@Unique(['tsCode', 'tradeDate'])
export class MoneyFlowStockEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Index()
  @Column({ name: 'ts_code', length: 16 })
  tsCode: string;

  @Index()
  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ length: 32, nullable: true })
  name: string | null;

  @Column({ name: 'pct_change', type: 'numeric', precision: 20, scale: 4, nullable: true })
  pctChange: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  latest: string | null;

  @Column({ name: 'net_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netAmount: string | null;

  @Column({ name: 'net_d5_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  netD5Amount: string | null;

  @Column({ name: 'buy_lg_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyLgAmount: string | null;

  @Column({ name: 'buy_lg_amount_rate', type: 'numeric', precision: 10, scale: 4, nullable: true })
  buyLgAmountRate: string | null;

  @Column({ name: 'buy_md_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buyMdAmount: string | null;

  @Column({ name: 'buy_md_amount_rate', type: 'numeric', precision: 10, scale: 4, nullable: true })
  buyMdAmountRate: string | null;

  @Column({ name: 'buy_sm_amount', type: 'numeric', precision: 20, scale: 4, nullable: true })
  buySmAmount: string | null;

  @Column({ name: 'buy_sm_amount_rate', type: 'numeric', precision: 10, scale: 4, nullable: true })
  buySmAmountRate: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
