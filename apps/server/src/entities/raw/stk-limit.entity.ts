// raw.stk_limit —— TuShare stk_limit 接口落库（Python sync 拥有）
// 只读 entity；本里程碑不写 service / controller。

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'raw', name: 'stk_limit' })
export class StkLimitEntity {
  @PrimaryColumn({ name: 'ts_code', length: 16 })
  tsCode: string;

  @Index()
  @PrimaryColumn({ name: 'trade_date', length: 8 })
  tradeDate: string;

  @Column({ name: 'pre_close', type: 'numeric', precision: 30, scale: 10, nullable: true })
  preClose: string | null;

  @Column({ name: 'up_limit', type: 'numeric', precision: 30, scale: 10, nullable: true })
  upLimit: string | null;

  @Column({ name: 'down_limit', type: 'numeric', precision: 30, scale: 10, nullable: true })
  downLimit: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
