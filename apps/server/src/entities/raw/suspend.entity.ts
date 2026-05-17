// raw.suspend_d —— TuShare suspend_d 接口落库（Python sync 拥有）
// 只读 entity；本里程碑不写 service / controller。

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'raw', name: 'suspend_d' })
export class SuspendEntity {
  @PrimaryColumn({ name: 'ts_code', length: 16 })
  tsCode: string;

  @Index()
  @PrimaryColumn({ name: 'trade_date', length: 8 })
  tradeDate: string;

  // 'S' = 停牌；'R' = 复牌（DB CHECK 已约束）
  @PrimaryColumn({ name: 'suspend_type', length: 1 })
  suspendType: string;

  // 日内停牌时间段，如 '09:30-10:00'；全天停牌时为 NULL
  @Column({ name: 'suspend_timing', type: 'text', nullable: true })
  suspendTiming: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
