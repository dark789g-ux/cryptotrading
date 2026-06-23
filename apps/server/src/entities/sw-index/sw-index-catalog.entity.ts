import { Column, CreateDateColumn, Entity, Index, PrimaryColumn, UpdateDateColumn } from 'typeorm';

/**
 * 申万行业指数目录（一/二/三级）。
 *
 * 来源：Tushare `sw_daily` / `index_member`（申万 ShenWan 行业分类体系）。
 * l1_* / l2_* / l3_* 冗余存各层级父链，便于按层级聚合查询。
 *
 * 注：`level` DB 列无 CHECK 约束（与 ths_index_catalog.type、index_daily_quotes.category
 * 风格一致），TS 联合类型 1|2|3 仅约束代码层，由同步 fetcher + service 保证取值。
 */
@Entity('sw_index_catalog')
@Index('idx_sw_index_catalog_level', ['level'])
export class SwIndexCatalogEntity {
  @PrimaryColumn({ name: 'ts_code', length: 20 })
  tsCode: string;

  @Column({ name: 'name', length: 100 })
  name: string;

  /** 申万行业层级：1=一级行业、2=二级行业、3=三级行业 */
  @Column({ name: 'level', type: 'smallint' })
  level: 1 | 2 | 3;

  @Column({ name: 'l1_code', length: 20, nullable: true })
  l1Code: string | null;

  @Column({ name: 'l1_name', length: 100, nullable: true })
  l1Name: string | null;

  @Column({ name: 'l2_code', length: 20, nullable: true })
  l2Code: string | null;

  @Column({ name: 'l2_name', length: 100, nullable: true })
  l2Name: string | null;

  @Column({ name: 'l3_code', length: 20, nullable: true })
  l3Code: string | null;

  @Column({ name: 'l3_name', length: 100, nullable: true })
  l3Name: string | null;

  @Column({ name: 'member_count', type: 'int', nullable: true })
  memberCount: number | null;

  @Column({ name: 'published', type: 'boolean', nullable: true })
  published: boolean | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @UpdateDateColumn({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
