import { Column, Entity, Index, PrimaryGeneratedColumn } from 'typeorm';

/**
 * `research.kelly_sweep_results`：凯利网格搜索全量结果表。
 *
 * - schema/name：`@Entity({ schema: 'research', name: 'kelly_sweep_results' })`
 * - 表由 Python 侧 alembic 建表，NestJS 仅只读查询（synchronize: false）。
 * - 列定义严格对齐 spec 02-data-model.md DDL + ResultRow（sweep.py:135-212，2026-06-09 核实）。
 * - `valid_keys` 不入表（每行可能上千个 key，CI 已由 rank_top_k 算好存进 kelly_ci_low/high）。
 *
 * ⚠ 实体双注册（项目硬约束，历史 EntityMetadataNotFound 500 教训）：
 *   ① `KellySweepModule`（或 QuantModule）`TypeOrmModule.forFeature([KellySweepResult])`
 *   ② `app.module.ts` 根 `entities` 数组
 *   漏 ② → 编译绿、运行时 500。
 */
@Entity({ schema: 'research', name: 'kelly_sweep_results' })
@Index('idx_ksr_job_group', ['jobId', 'windowGroup'])
@Index('idx_ksr_job_topk', ['jobId', 'isTopk', 'kellyValid'])
export class KellySweepResult {
  @PrimaryGeneratedColumn({ name: 'id', type: 'bigint' })
  id: string; // bigint 在 JS 侧以 string 取回，防精度丢失

  /** 关联的 ml.jobs.id */
  @Column({ name: 'job_id', type: 'uuid' })
  jobId: string;

  /** 分组：'with_rs' | 'no_rs' */
  @Column({ name: 'window_group', type: 'text' })
  windowGroup: string;

  /** 入场变体唯一标识（如 "kdj_j<0"） */
  @Column({ name: 'variant_id', type: 'text' })
  variantId: string;

  /** 入场过滤条件列表，[[feature,op,value],...] */
  @Column({ name: 'variant_filters', type: 'jsonb' })
  variantFilters: [string, string, number][][];

  /** 出场参数唯一标识（如 "fixed_n(n=5)"） */
  @Column({ name: 'exit_id', type: 'text' })
  exitId: string;

  /** 出场参数配置 {type, ...} */
  @Column({ name: 'exit_cfg', type: 'jsonb' })
  exitCfg: Record<string, unknown>;

  /** 训练集信号数 */
  @Column({ name: 'n_train', type: 'int' })
  nTrain: number;

  /** 训练集 Kelly（可空，n=0 时 null） */
  @Column({ name: 'kelly_train', type: 'double precision', nullable: true })
  kellyTrain: number | null;

  /** 训练集胜率（可空） */
  @Column({ name: 'win_rate_train', type: 'double precision', nullable: true })
  winRateTrain: number | null;

  /** 训练集盈亏比（可空） */
  @Column({ name: 'payoff_b_train', type: 'double precision', nullable: true })
  payoffBTrain: number | null;

  /** 训练集盈利因子（可空） */
  @Column({ name: 'profit_factor_train', type: 'double precision', nullable: true })
  profitFactorTrain: number | null;

  /** 验证集信号数 */
  @Column({ name: 'n_valid', type: 'int' })
  nValid: number;

  /** 验证集 Kelly（OOS 主排序指标，可空） */
  @Column({ name: 'kelly_valid', type: 'double precision', nullable: true })
  kellyValid: number | null;

  /** 验证集胜率（可空） */
  @Column({ name: 'win_rate_valid', type: 'double precision', nullable: true })
  winRateValid: number | null;

  /** 验证集盈亏比（可空） */
  @Column({ name: 'payoff_b_valid', type: 'double precision', nullable: true })
  payoffBValid: number | null;

  /** 验证集盈利因子（可空） */
  @Column({ name: 'profit_factor_valid', type: 'double precision', nullable: true })
  profitFactorValid: number | null;

  /** 信号数 < min_samples → true（样本不足，灰点显示） */
  @Column({ name: 'below_floor', type: 'boolean' })
  belowFloor: boolean;

  /** Kelly CI 下界（仅 top-K 行非空，由 rank_top_k bootstrap 算出） */
  @Column({ name: 'kelly_ci_low', type: 'double precision', nullable: true })
  kellyCiLow: number | null;

  /** Kelly CI 上界（仅 top-K 行非空） */
  @Column({ name: 'kelly_ci_high', type: 'double precision', nullable: true })
  kellyCiHigh: number | null;

  /** 是否在帕累托前沿（compute_pareto_frontier 标记） */
  @Column({ name: 'is_frontier', type: 'boolean', default: false })
  isFrontier: boolean;

  /** 是否入选 top-K（rank_top_k 标记） */
  @Column({ name: 'is_topk', type: 'boolean', default: false })
  isTopk: boolean;

  /** 同日规则：'sl_first' | 'tp_first' */
  @Column({ name: 'same_day_rule', type: 'text' })
  sameDayRule: string;

  /** 写入时间 */
  @Column({ name: 'created_at', type: 'timestamptz', default: () => 'now()' })
  createdAt: Date;
}
