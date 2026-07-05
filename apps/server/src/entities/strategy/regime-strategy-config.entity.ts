import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { StrategyConditionItem } from './strategy-condition.entity';

/**
 * 原 'Q1'|'Q2'|'Q3'|'Q4' 字面量联合已退役。
 * 现在 regime key 由用户自定义，保留 string 别名作为过渡兼容。
 */
export type RegimeKey = string;

export type RegimeConfigStatus = 'draft' | 'active' | 'archived';

export type RegimeExitMode = 'trailing_lock' | 'fixed_n' | 'strategy';

export interface QuadrantEntry {
  /** 用户自定义象限标识（配置内唯一）。 */
  key: string;
  /** 象限显示标签（必填，无 fallback）。 */
  label: string;
  /** 大盘级分桶条件：命中即归此象限。 */
  match: StrategyConditionItem[];
  /** 配置中只允许 trade/flat（unknown 是运行期 regime，不可配置）。 */
  action: 'trade' | 'flat';
  /** 入场条件（个股级）；flat 象限为 null。 */
  entryConditions?: StrategyConditionItem[] | null;
  /** 出场模式；flat 象限为 null。 */
  exitMode?: RegimeExitMode | null;
  /** 出场参数；flat 象限为 null。 */
  exitParams?: Record<string, unknown> | null;
  /** 研究证据（可选）。 */
  evidence?: Record<string, unknown> | null;
  /** optional extra config */
  [key: string]: unknown;
}

export type RegimeConfigEntry = QuadrantEntry;

export interface RegimeConfigMap {
  /** 基准大盘指数 ts_code（如 '000001.SH'）。 */
  marketIndex: string;
  /** 有序象限数组；顺序 = 匹配优先级。 */
  quadrants: QuadrantEntry[];
}

@Entity('regime_strategy_config')
export class RegimeStrategyConfigEntity {
  @PrimaryGeneratedColumn('uuid')
  id: string;

  @Column({ type: 'int', unique: true })
  version: number;

  @Column({ type: 'varchar', length: 10 })
  status: RegimeConfigStatus;

  @Column({ type: 'text', nullable: true })
  note: string | null;

  @CreateDateColumn({ name: 'created_at', type: 'timestamptz' })
  createdAt: Date;

  @Column({ type: 'jsonb' })
  config: RegimeConfigMap;
}
