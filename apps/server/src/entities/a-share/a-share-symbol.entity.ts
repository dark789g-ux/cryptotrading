import { Column, Entity, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('a_share_symbols')
export class AShareSymbolEntity {
  @PrimaryColumn({ name: 'ts_code' })
  tsCode: string;

  @Column()
  symbol: string;

  @Column()
  name: string;

  @Column({ nullable: true })
  area: string;

  @Column({ name: 'sw_industry_l1_code', length: 20, nullable: true })
  swIndustryL1Code: string | null;

  @Column({ name: 'sw_industry_l2_code', length: 20, nullable: true })
  swIndustryL2Code: string | null;

  @Column({ name: 'sw_industry_l3_code', length: 20, nullable: true })
  swIndustryL3Code: string | null;

  @Column({ nullable: true })
  market: string;

  @Column({ nullable: true })
  exchange: string;

  @Column({ name: 'list_status', nullable: true })
  listStatus: string;

  @Column({ name: 'list_date', nullable: true })
  listDate: string;

  @Column({ name: 'delist_date', nullable: true })
  delistDate: string;

  @Column({ name: 'is_hs', nullable: true })
  isHs: string;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
