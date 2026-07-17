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

export interface RegimeBucketCondition {
  type: 'index' | 'stock';
  target: string;
  field: string;
  operator: string;
  value?: number;
  compareField?: string;
  compareMode?: 'value' | 'field';
}

/** 条件分组，支持嵌套 AND/OR */
export interface MatchGroup {
  logic: 'and' | 'or';
  items: MatchNode[];
}

/** match 数组的元素：要么是叶子条件，要么是分组 */
export type MatchNode = RegimeBucketCondition | MatchGroup;

/** 判断 match 节点是否为分组（MatchGroup）而非叶子条件。
 *  区分依据：MatchGroup 有 logic+items 字段但无 type 字段；RegimeBucketCondition 有 type 字段。 */
export function isMatchGroup(node: unknown): node is MatchGroup {
  return typeof node === 'object' && node !== null && 'logic' in node && 'items' in node && !('type' in node);
}

/** 从 match 节点数组中递归收集所有叶子条件的 target（index/stock）。
 *  用于 MarketSnapshotLoader / regime-engine.service 决定加载哪些指数/个股数据。 */
export function collectMatchTargets(nodes: MatchNode[]): { index: Set<string>; stock: Set<string> } {
  const index = new Set<string>();
  const stock = new Set<string>();
  function walk(items: MatchNode[]): void {
    for (const node of items) {
      if (isMatchGroup(node)) {
        walk(node.items);
      } else {
        if (node.type === 'index') {
          index.add(node.target);
        } else if (node.type === 'stock') {
          stock.add(node.target);
        }
      }
    }
  }
  walk(nodes);
  return { index, stock };
}

export interface QuadrantEntry {
  /** 用户自定义象限标识（配置内唯一）。 */
  key: string;
  /** 象限显示标签（必填，无 fallback）。 */
  label: string;
  /** 大盘级分桶条件：命中即归此象限。支持叶子条件(RegimeBucketCondition)或嵌套分组(MatchGroup)。 */
  match: MatchNode[];
  /** match 数组的逻辑连接方式:默认 'and'(全部满足),'or' = 任一满足即命中本象限 */
  matchLogic?: 'and' | 'or';
  /** 配置中只允许 trade/flat（unknown 是运行期 regime，不可配置）。 */
  action: 'trade' | 'flat';
  /** 入场条件（个股级）；flat 象限为 null。 */
  entryConditions?: StrategyConditionItem[] | null;
  /** 出场模式；flat 象限为 null。 */
  exitMode?: RegimeExitMode | null;
  /** 出场参数；flat 象限为 null。 */
  exitParams?: Record<string, unknown> | null;
  /** 该象限允许使用的仓位比例（0-1）。 */
  positionRatio?: number | null;
  /** 该象限允许同时持有的最大标的数。 */
  maxPositions?: number | null;
  /** trade 必填；短名单见 RANK_FIELD_WHITELIST */
  rankField?: string | null;
  /** rankField≠none 时必填 */
  rankDir?: 'asc' | 'desc' | null;
  /** trade 可选：仅当全部现存持仓盈利时才开新仓；缺省 false */
  requireAllPositionsProfitable?: boolean;
  /** 研究证据（可选）。 */
  evidence?: Record<string, unknown> | null;
  /** optional extra config */
  [key: string]: unknown;
}

export type RegimeConfigEntry = QuadrantEntry;

/** 信号枚举标的池。缺省或 mode=all 为全市场。 */
export interface RegimeUniverse {
  mode: 'all' | 'watchlist' | 'symbols';
  watchlistId?: string;
  symbols?: string[];
}

export interface RegimeConfigMap {
  /** @deprecated 旧版顶层基准大盘指数，已下放到各 quadrant match 的 target 中；保留可选字段以兼容历史数据。 */
  marketIndex?: string;
  /** 有序象限数组；顺序 = 匹配优先级。 */
  quadrants: QuadrantEntry[];
  /** 信号枚举标的池；缺省 = 全市场。 */
  universe?: RegimeUniverse;
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
