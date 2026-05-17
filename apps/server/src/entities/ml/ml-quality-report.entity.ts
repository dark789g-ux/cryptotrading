import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `ml.quality_reports`：数据质量门禁产生的告警 / 拦截记录。
 *
 * - rule 清单见 01-pg-schema.md §4.3
 * - level: info | warn | critical
 * - M2 仅声明只读 entity，read controller 留 M3
 */
export type MlQualityLevel = 'info' | 'warn' | 'critical';

@Entity({ schema: 'ml', name: 'quality_reports' })
@Index(['tradeDate', 'level'])
export class MlQualityReportEntity {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string;

  @Column({ name: 'trade_date', type: 'char', length: 8 })
  tradeDate: string;

  @Column({ name: 'level', type: 'text' })
  level: MlQualityLevel;

  @Column({ name: 'rule', type: 'text' })
  rule: string;

  @Column({ name: 'detail', type: 'jsonb' })
  detail: Record<string, unknown>;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
