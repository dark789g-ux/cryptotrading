import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('custom_index_money_flow')
export class CustomIndexMoneyFlowEntity {
  @PrimaryColumn({ name: 'custom_index_id', type: 'uuid' })
  customIndexId: string;

  @PrimaryColumn({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'net_amount', type: 'double precision', nullable: true })
  netAmount: number | null;

  @Column({ name: 'buy_lg_amount', type: 'double precision', nullable: true })
  buyLgAmount: number | null;

  @Column({ name: 'buy_md_amount', type: 'double precision', nullable: true })
  buyMdAmount: number | null;

  @Column({ name: 'buy_sm_amount', type: 'double precision', nullable: true })
  buySmAmount: number | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
