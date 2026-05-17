// raw.fina_indicator —— TuShare fina_indicator 接口落库（Python sync 拥有）
// 只读 entity；本里程碑不写 service / controller。
//
// PIT 关键：ann_date 必入主键。同一报告期可能有修正公告（多次 ann_date 全部保留）；
// 因子计算必须按 ann_date 过滤，禁止单独以 end_date 作为 PIT 键（CLAUDE.md / spec 硬约束）。
// 80+ 财务指标统一以 jsonb 列 indicators 全量保留，避免 schema 漂移耦合。

import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

@Entity({ schema: 'raw', name: 'fina_indicator' })
export class FinaIndicatorEntity {
  @PrimaryColumn({ name: 'ts_code', length: 16 })
  tsCode: string;

  // 报告期 YYYYMMDD（每季度最后一天）
  @PrimaryColumn({ name: 'end_date', length: 8 })
  endDate: string;

  // PIT 关键：公告日期 YYYYMMDD
  @Index()
  @PrimaryColumn({ name: 'ann_date', length: 8 })
  annDate: string;

  // 80+ 指标全量；键值参考 TuShare 文档（eps / roe / debt_to_assets / ...）
  @Column({ name: 'indicators', type: 'jsonb' })
  indicators: Record<string, unknown>;

  @Column({ name: 'update_flag', length: 1, nullable: true })
  updateFlag: string | null;

  @Column({ name: 'updated_at', type: 'timestamptz' })
  updatedAt: Date;
}
