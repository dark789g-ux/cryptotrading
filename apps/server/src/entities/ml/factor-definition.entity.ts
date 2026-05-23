import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * `factors.factor_definitions`：因子元信息单一权威表。
 *
 * - schema/name 来自 spec 2026-05-23-factor-registry-frontend-design/01-db-schema.md
 * - 由 Alembic（quant-pipeline）建表，NestJS `synchronize: false`；
 *   `apps/server/migrations/20260524_factor_definitions.sql` 仅做幂等校验
 * - 命名风格：类属性驼峰 + `@Column({ name: 'snake_case' })` 映射 DB 列
 *   （参考 `ml-job.entity.ts`）
 */
@Entity({ schema: 'factors', name: 'factor_definitions' })
@Index('idx_factor_definitions_enabled_category', ['enabled', 'category'])
export class FactorDefinitionEntity {
  @PrimaryColumn({ name: 'factor_id', type: 'varchar', length: 64 })
  factorId: string;

  @PrimaryColumn({ name: 'factor_version', type: 'varchar', length: 16 })
  factorVersion: string;

  @Column({ type: 'text' })
  description: string;

  @Column({ type: 'text', nullable: true })
  formula: string | null;

  /** 用到的底层列/表，仅供阅读；不影响计算 */
  @Column({ name: 'data_source', type: 'text', array: true, nullable: true })
  dataSource: string[] | null;

  /** price / industry / fundamental / mixed（CHECK 在 DB 层） */
  @Column({ type: 'varchar', length: 32 })
  category: string;

  @Column({ name: 'pit_window_days', type: 'int' })
  pitWindowDays: number;

  /** trade_date / ann_date（CHECK 在 DB 层） */
  @Column({ name: 'pit_anchor', type: 'varchar', length: 16 })
  pitAnchor: string;

  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  @Column({ name: 'display_order', type: 'int', default: 100 })
  displayOrder: number;

  @Column({ name: 'updated_at', type: 'timestamptz', default: () => 'now()' })
  updatedAt: Date;

  /** 修改人 user uuid；初始 migration 灌入时为 NULL（"系统初始化"） */
  @Column({ name: 'updated_by', type: 'varchar', length: 64, nullable: true })
  updatedBy: string | null;
}
