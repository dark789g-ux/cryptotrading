// raw.trade_cal —— TuShare trade_cal 接口落库（Python sync 拥有）
// 此处 NestJS 端只声明只读 entity，供未来读侧使用；本里程碑不写 service / controller。

import { Column, Entity, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'raw', name: 'trade_cal' })
export class TradeCalEntity {
  @PrimaryColumn({ name: 'exchange', length: 8 })
  exchange: string;

  // A 股 trade_date 规范：char(8) YYYYMMDD（CLAUDE.md）
  @PrimaryColumn({ name: 'cal_date', length: 8 })
  calDate: string;

  @Column({ name: 'is_open', type: 'smallint' })
  isOpen: number;

  @Column({ name: 'pretrade_date', length: 8, nullable: true })
  pretradeDate: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
