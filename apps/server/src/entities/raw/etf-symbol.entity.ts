import { Column, Entity, PrimaryGeneratedColumn, Unique, UpdateDateColumn } from 'typeorm';

@Entity({ schema: 'raw', name: 'etf_symbol' })
@Unique(['tsCode'])
export class EtfSymbolEntity {
  @PrimaryGeneratedColumn('increment', { type: 'bigint' })
  id: string;

  @Column({ name: 'ts_code', length: 16 })
  tsCode: string;

  @Column({ length: 100 })
  name: string;

  @Column({ length: 4 })
  exchange: string;

  @Column({ name: 'fund_type', length: 32, nullable: true })
  fundType: string | null;

  @Column({ length: 100, nullable: true })
  manager: string | null;

  @Column({ name: 'index_code', length: 20, nullable: true })
  indexCode: string | null;

  @Column({ name: 'publish_iopv', type: 'boolean' })
  publishIopv: boolean;

  @Column({ type: 'boolean' })
  tracked: boolean;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
