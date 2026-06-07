import { Column, Entity, Index, PrimaryColumn } from 'typeorm';
import type { ExitRuleDef } from '@cryptotrading/shared-types';

/**
 * `factors.strategy_definitions`：量化「出场策略」定义单一权威表。
 *
 * - schema/name 来自 spec 2026-06-06-quant-strategy-management-design/02-data-model-and-migration.md
 * - 由 Alembic（quant-pipeline）建表，NestJS `synchronize: false`；本实体仅做读写。
 * - 命名风格：类属性驼峰 + `@Column({ name: 'snake_case' })` 映射 DB 列
 *   （镜像 `label-definition.entity.ts`）
 *
 * ⚠ 实体双注册（项目踩过的坑 [[project_typeorm_entity_dual_registration]]）：
 *   ① `modules/quant/strategies/strategies.module.ts`
 *      `TypeOrmModule.forFeature([... StrategyDefinitionEntity])`
 *   ② `app.module.ts` 根 `entities` 数组
 *   漏 ② → 编译绿、运行时 `EntityMetadataNotFound` 500。
 *
 * 命名避碰：项目已有顶层 `apps/server/src/strategies/`（StrategyEntity，crypto 回测域，**勿动**）；
 * 本实体一律用 `StrategyDefinition*`。
 *
 * exit_rules 合法 type / params 范围权威在 Python `build_exit_rules` + NestJS DTO，
 * DB **不加** CHECK 约束（避免三处真相源）。
 */
@Entity({ schema: 'factors', name: 'strategy_definitions' })
@Index('ix_strategy_definitions_enabled', ['enabled'])
export class StrategyDefinitionEntity {
  @PrimaryColumn({ name: 'strategy_id', type: 'varchar', length: 64 })
  strategyId: string;

  @PrimaryColumn({ name: 'strategy_version', type: 'varchar', length: 16 })
  strategyVersion: string;

  /** 人类可读名，如"默认出场策略"；NOT NULL */
  @Column({ type: 'text' })
  name: string;

  /**
   * 出场规则列表（jsonb）。first-match：数组顺序即优先级。
   * 每元素 `{ type, params }`，type / params 范围见 shared-types `ExitRuleDef`
   * 与 spec 02 §2；后端 DTO 校验，DB 不加 CHECK。
   */
  @Column({ name: 'exit_rules', type: 'jsonb', default: '[]' })
  exitRules: ExitRuleDef[];

  /** 中文描述 */
  @Column({ type: 'text', nullable: true })
  description: string | null;

  /** 启停（前端选择器只列 enabled=true 的） */
  @Column({ type: 'boolean', default: true })
  enabled: boolean;

  /** 前端排序 */
  @Column({ name: 'display_order', type: 'int', default: 0 })
  displayOrder: number;

  /** 项目规则：时间列一律 timestamptz */
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
