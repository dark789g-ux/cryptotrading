// raw.index_member —— TuShare index_member_all 接口落库（Python sync 拥有，PIT 关键）
// 只读 entity；本里程碑不写 service / controller。
//
// 行业归属 PIT 安全：in_date / out_date 表示成员关系的时间区间；
// out_date 为 NULL 表示该成份股仍在此三级行业。

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'raw', name: 'index_member' })
export class IndexMemberEntity {
  // 三级行业代码（如 '850531.SI'）
  @PrimaryColumn({ name: 'l3_code', length: 16 })
  l3Code: string;

  @Index()
  @PrimaryColumn({ name: 'ts_code', length: 16 })
  tsCode: string;

  // PIT 关键：纳入日期
  @PrimaryColumn({ name: 'in_date', length: 8 })
  inDate: string;

  // 剔除日期；NULL 表示仍在该行业
  @Column({ name: 'out_date', length: 8, nullable: true })
  outDate: string | null;

  @Column({ name: 'l1_code', length: 16, nullable: true })
  l1Code: string | null;

  @Column({ name: 'l1_name', type: 'text', nullable: true })
  l1Name: string | null;

  @Column({ name: 'l2_code', length: 16, nullable: true })
  l2Code: string | null;

  @Column({ name: 'l2_name', type: 'text', nullable: true })
  l2Name: string | null;

  @Column({ name: 'l3_name', type: 'text', nullable: true })
  l3Name: string | null;

  @Column({ name: 'name', type: 'text', nullable: true })
  name: string | null;

  // 'Y' / 'N'
  @Column({ name: 'is_new', length: 1, nullable: true })
  isNew: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
