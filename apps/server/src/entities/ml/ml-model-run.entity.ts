import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `ml.model_runs`：一次成功的训练对应一行，含 OOS metrics + artifact 路径。
 *
 * M2 仅声明只读 entity（不在本 module 暴露 mutator），service / controller 留至 M3。
 */
@Entity({ schema: 'ml', name: 'model_runs' })
export class MlModelRunEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ name: 'job_id', type: 'uuid', nullable: true })
  jobId: string | null;

  @Index({ unique: true })
  @Column({ name: 'model_version', type: 'text' })
  modelVersion: string;

  @Column({ name: 'feature_set_id', type: 'text' })
  featureSetId: string;

  @Column({ name: 'hyperparams', type: 'jsonb' })
  hyperparams: Record<string, unknown>;

  /** {ndcg@5, ndcg@10, ic, rank_ic, portfolio_annual_after_cost, fold_metrics[]} */
  @Column({ name: 'oos_metrics', type: 'jsonb' })
  oosMetrics: Record<string, unknown>;

  /** POSIX 风格相对路径 './artifacts/<uuid>/model.txt' */
  @Column({ name: 'artifact_uri', type: 'text' })
  artifactUri: string;

  @Column({ name: 'report_uri', type: 'text', nullable: true })
  reportUri: string | null;

  /** M4 才写 */
  @Column({ name: 'shap_uri', type: 'text', nullable: true })
  shapUri: string | null;

  /**
   * 模型生命周期状态：prod / shadow / archived（DB 层 CHECK 约束）。
   * migration 20260529_ml_model_runs_status.sql 已建列 + 索引；本 entity 只读。
   */
  @Column({ name: 'status', type: 'text', default: () => "'shadow'" })
  status: string;

  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
