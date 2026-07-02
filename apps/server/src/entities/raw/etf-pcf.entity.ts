import {
  Column,
  Entity,
  Index,
  PrimaryGeneratedColumn,
  Unique,
  UpdateDateColumn,
} from 'typeorm';

@Entity({ schema: 'raw', name: 'etf_pcf' })
@Unique(['tsCode', 'tradeDate', 'conCode'])
@Index('idx_etf_pcf_code_date', ['tsCode', 'tradeDate'])
@Index('idx_etf_pcf_date', ['tradeDate'])
export class EtfPcfEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'ts_code', length: 16 })
  tsCode: string;

  @Column({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'fund_name', length: 100, nullable: true })
  fundName: string | null;

  @Column({ length: 100, nullable: true })
  manager: string | null;

  @Column({ name: 'fund_type', length: 32, nullable: true })
  fundType: string | null;

  @Column({ name: 'index_code', length: 20, nullable: true })
  indexCode: string | null;

  @Column({ name: 'creation_unit', type: 'numeric', precision: 20, scale: 4, nullable: true })
  creationUnit: string | null;

  @Column({ name: 'max_cash_ratio', type: 'numeric', precision: 20, scale: 4, nullable: true })
  maxCashRatio: string | null;

  @Column({ name: 'publish_iopv', type: 'boolean', nullable: true })
  publishIopv: boolean | null;

  @Column({ name: 'con_code', length: 16 })
  conCode: string;

  @Column({ name: 'con_name', length: 100, nullable: true })
  conName: string | null;

  @Column({ type: 'numeric', precision: 20, scale: 4, nullable: true })
  quantity: string | null;

  @Column({ name: 'subst_flag', length: 10, nullable: true })
  substFlag: string | null;

  @Column({ name: 'premium_rate', type: 'numeric', precision: 20, scale: 4, nullable: true })
  premiumRate: string | null;

  @Column({ name: 'discount_rate', type: 'numeric', precision: 20, scale: 4, nullable: true })
  discountRate: string | null;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
