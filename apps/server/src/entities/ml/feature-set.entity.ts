import { Column, Entity, PrimaryColumn } from 'typeorm';

/**
 * `factors.feature_sets`：已物化特征集元信息表。
 *
 * - schema/name 来自 spec 2026-06-06-labels-features-incremental-prepare-design/03-backend-decoupling.md
 * - 由 Alembic（quant-pipeline）建表，NestJS `synchronize: false`；本实体仅做只读查询。
 * - `label_id` / `label_version` 为 nullable 列，由 P6 migration 加入；
 *   历史行值为 NULL，查询需容错（LEFT JOIN + 回退 scheme）。
 * - 命名风格：类属性驼峰 + `@Column({ name: 'snake_case' })` 映射 DB 列
 *   （参考 `factor-definition.entity.ts`）
 *
 * ⚠ 实体双注册（项目踩过的坑）：
 *   ① `quant-feature-sets.module.ts`（或 quant.module.ts）`TypeOrmModule.forFeature([... FeatureSetEntity])`
 *   ② `app.module.ts` 根 `entities` 数组
 *   漏 ② → 编译绿、运行时 `EntityMetadataNotFound` 500。
 */
@Entity({ schema: 'factors', name: 'feature_sets' })
export class FeatureSetEntity {
  @PrimaryColumn({ name: 'feature_set_id', type: 'varchar', length: 64 })
  featureSetId: string;

  @Column({ name: 'factor_version', type: 'varchar', length: 16 })
  factorVersion: string;

  /** 完整 scheme 字符串（如 "20240101_20260101_30d"），作为 label_name 缺失时的回退显示 */
  @Column({ type: 'text' })
  scheme: string;

  @Column({ name: 'new_listing_min_days', type: 'int' })
  newListingMinDays: number;

  /** 因子 ID 数组；DB 列为 text[] */
  @Column({ name: 'factor_ids', type: 'text', array: true, nullable: true })
  factorIds: string[] | null;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;

  /**
   * 命名标签 ID（来自 factors.label_definitions.label_id）。
   *
   * NULL 兼容：历史 feature_sets 行（P6 migration 前）此列为 NULL；
   * 查询时 LEFT JOIN label_definitions，缺失则回退 scheme 字符串。
   */
  @Column({ name: 'label_id', type: 'text', nullable: true })
  labelId: string | null;

  /**
   * 命名标签版本（与 label_id 配对）。
   *
   * label_id NULL 时此列也为 NULL。
   * DB 列类型为 int（spec §03 "feature_sets 加列"），此处映射为 number | null。
   */
  @Column({ name: 'label_version', type: 'int', nullable: true })
  labelVersion: number | null;
}
