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

  /**
   * 指数类别：'I'=行业指数、'N'=概念/题材板块、'M'=市场大盘指数（000001.SH 等）。
   * 注：DB 列无 CHECK 约束（migration 未加），TS 联合类型仅约束代码层。
   */
  @Column({ name: 'type', length: 4 })
  type: 'I' | 'N' | 'M';

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
