import { Column, Entity, Index, PrimaryColumn } from 'typeorm';

/**
 * `factors.label_definitions`：命名标签定义单一权威表。
 *
 * - schema/name 来自 spec 2026-06-05-quant-label-management-design/01-overview-and-data-model.md
 * - 由 Alembic（quant-pipeline）建表，NestJS `synchronize: false`；
 *   本实体仅做读写。
 * - 命名风格：类属性驼峰 + `@Column({ name: 'snake_case' })` 映射 DB 列
 *   （参考 `factor-definition.entity.ts`）
 *
 * ⚠ 实体双注册（项目踩过的坑）：
 *   ① `quant.module.ts` `TypeOrmModule.forFeature([... LabelDefinitionEntity])`
 *   ② `app.module.ts` 根 `entities` 数组
 *   漏 ② → 编译绿、运行时 `EntityMetadataNotFound` 500。
 *
 * base_type / classify_mode 合法枚举权威在 Python labels 模块
 * （`quant_pipeline/labels/`），后端此处为**镜像**。DB 不加 CHECK 约束
 * （避免三处真相源；新增类型改 migration 成本高）。
 */
@Entity({ schema: 'factors', name: 'label_definitions' })
@Index('ix_label_definitions_enabled_base', ['enabled', 'baseType'])
export class LabelDefinitionEntity {
  @PrimaryColumn({ name: 'label_id', type: 'varchar', length: 64 })
  labelId: string;

  @PrimaryColumn({ name: 'label_version', type: 'varchar', length: 16 })
  labelVersion: string;

  /** 人类可读名，如"次日涨跌·横盘±0.5%"；NOT NULL */
  @Column({ type: 'text' })
  name: string;

  /**
   * 基础层类型。
   * 合法枚举（权威在 Python）：fwd_ret | strategy_aware
   * 此处不加 CHECK，仅后端 DTO 校验。
   */
  @Column({ name: 'base_type', type: 'text' })
  baseType: string;

  /**
   * 基础层参数（jsonb）。
   * fwd_ret: { horizon: number }
   * strategy_aware: { max_hold_days: number }
   */
  @Column({ name: 'base_params', type: 'jsonb', default: '{}' })
  baseParams: Record<string, unknown>;

  /**
   * 分类层方式。
   * 合法枚举（权威在 Python）：NULL（连续）| band | tercile | custom
   * nullable=true 对应 SQL NULL（连续值，回归/排序用）。
   */
  @Column({ name: 'classify_mode', type: 'text', nullable: true })
  classifyMode: string | null;

  /**
   * 分类层参数（jsonb）。
   * band: { eps: number }
   * tercile/NULL: {}
   * custom: { thresholds: number[] }
   */
  @Column({ name: 'classify_params', type: 'jsonb', default: '{}' })
  classifyParams: Record<string, unknown>;

  /** 中文描述 */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 启停（训练下拉只列 enabled=true 的） */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** 前端排序 */
  @Column({ name: 'display_order', type: 'int', default: 0 })
  displayOrder: number;

  /** 项目规则：时间列一律 timestamptz */
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
