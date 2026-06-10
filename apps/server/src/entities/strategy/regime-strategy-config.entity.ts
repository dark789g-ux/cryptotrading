import {
  Entity,
  PrimaryGeneratedColumn,
  Column,
  CreateDateColumn,
} from 'typeorm';
import { StrategyConditionItem } from './strategy-condition.entity';

export type RegimeKey = 'Q1' | 'Q2' | 'Q3' | 'Q4';

export type RegimeConfigStatus = 'draft' | 'active' | 'archived';

export type RegimeExitMode = 'trailing_lock' | 'fixed_n' | 'strategy';

export interface RegimeConfigEntry {
  /** 配置中只允许 trade/flat（unknown 是运行期 regime，不可配置） */
  action: 'trade' | 'flat';
  /** 象限标签（如「反弹筑底」），flat 行落库作空仓理由 */
  label?: string | null;
  /** 入场条件（条件系统 JSON 原样执行）；flat 象限为 null */
  entryConditions?: StrategyConditionItem[] | null;
  /** 出场模式；flat 象限为 null。Phase 2 仅展示，不参与每日扫描 */
  exitMode?: RegimeExitMode | null;
  /** 出场参数（fixed_n: {N}；strategy: {exitConditions,maxHold}；trailing_lock: {maxHold|null}） */
  exitParams?: Record<string, unknown> | null;
  /** optional condition set or any extra config */
  [key: string]: unknown;
}

export type RegimeConfigMap = Record<RegimeKey, RegimeConfigEntry>;

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
