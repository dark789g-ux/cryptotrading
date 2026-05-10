import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

@Entity('ths_index_catalog')
@Index(['type'])
export class ThsIndexCatalogEntity {
  @PrimaryColumn({ name: 'ts_code', length: 20 })
  tsCode: string;

  @Column({ name: 'name', length: 100 })
  name: string;

  @Column({ name: 'count', type: 'int', nullable: true })
  count: number | null;

  @Column({ name: 'exchange', length: 8 })
  exchange: string;

  @Column({ name: 'list_date', length: 8, nullable: true })
  listDate: string | null;

  @Column({ name: 'type', length: 4 })
  type: 'I' | 'N';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
