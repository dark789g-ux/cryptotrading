// raw.index_classify —— TuShare index_classify 接口落库（Python sync 拥有）
// 只读 entity；本里程碑不写 service / controller。

import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'raw', name: 'index_classify' })
export class IndexClassifyEntity {
  // 'SW2014' / 'SW2021'
  @PrimaryColumn({ name: 'src', length: 16 })
  src: string;

  // 指数代码，如 '801010.SI'
  @PrimaryColumn({ name: 'index_code', length: 16 })
  indexCode: string;

  @Column({ name: 'industry_code', length: 16, nullable: true })
  industryCode: string | null;

  @Column({ name: 'industry_name', type: 'text' })
  industryName: string;

  @Column({ name: 'parent_code', length: 16, nullable: true })
  parentCode: string | null;

  // 行业层级 L1 / L2 / L3
  @Column({ name: 'level', length: 4, nullable: true })
  level: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
