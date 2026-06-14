/**
 * create-signal-test.dto.ts
 *
 * 创建信号前向统计方案的请求 DTO。
 * 校验在 service 层 fail-fast（class-validator 未全局启用，统一在 service 抛 BadRequestException）。
 */
import { StrategyConditionItem } from '../../../entities/strategy/strategy-condition.entity';
import {
  SignalTestUniverse,
  SignalTestBacktestConfig,
} from '../../../entities/strategy/signal-test.entity';

export interface CreateSignalTestDto {
  /** 方案名称，不超过 100 字符。 */
  name: string;

  /**
   * 买入条件（至少 1 条）。
   * 复用 StrategyConditionItem，字段/算子约束同 strategy-conditions 域。
   */
  buyConditions: StrategyConditionItem[];

  /**
   * 出场模式：
   * - `fixed_n`：固定 N 个交易日出场，须同时填 horizonN。
   * - `strategy`：卖出条件命中出场（或达到 maxHold 兜底），须同时填 exitConditions + maxHold。
   * - `trailing_lock`：波段跟踪止损（锁定 + MA5 收盘离场 + 跌停顺延），可选 maxHold 硬上限；
   *   无 horizonN、无 exitConditions。
   * - `phase_lock`：两阶段锁定止损（初始止损固定 → 收盘站上 MA5↑ 锁定上移 → 阶段 B 收盘破 MA5↓ 清仓 + 跌停顺延）；
   *   无 horizonN、无 exitConditions、无 maxHold。
   */
  exitMode: 'fixed_n' | 'strategy' | 'trailing_lock' | 'phase_lock';

  /**
   * fixed_n 模式：持有到 buy_date 后第 N 个实际可交易日。
   * exitMode='fixed_n' 时必填且 ≥1。
   */
  horizonN?: number;

  /**
   * strategy 模式：卖出条件（至少 1 条）。
   * exitMode='strategy' 时必填且非空。
   */
  exitConditions?: StrategyConditionItem[];

  /**
   * 最长持有可交易日数（兜底强平）。
   * - exitMode='strategy' 时必填且 ≥1。
   * - exitMode='trailing_lock' 时可选（留空=无硬上限）；若填须为整数且 ≥1。
   */
  maxHold?: number;

  // ── 波段跟踪止损专属参数（仅 exitMode='trailing_lock' 可送；其它模式误送 → 400）──
  // 均为可选；不传 = 用各自默认。ratio 量化到 0.001（round-half-up）。

  /** 止损缓冲系数（仅 trailing_lock）。留空=0.999；量化后范围 (0,1]（即 NNNN∈[1,1000]）。 */
  stopRatio?: number;

  /** 成本地板系数（仅 trailing_lock）。留空=0.999；量化后范围 [0.001,9.999]（即 NNNN∈[1,9999]），允许 >1（锁盈）。 */
  floorRatio?: number;

  /** 启用成本地板（仅 trailing_lock）。留空=true。 */
  floorEnabled?: boolean;

  /** 锁定后 MA5 离场是否要求 MA5 下行（仅 trailing_lock）。留空=true。 */
  ma5RequireDown?: boolean;

  // ── 阶段锁定专属参数（仅 exitMode='phase_lock' 可送；其它模式误送 → 400）──
  // 均为可选；不传 = 用各自默认。initFactor/lockFactor 量化到 0.001（round-half-up）。

  /** 初始止损系数（仅 phase_lock）。留空=0.999；量化后范围 (0,2.0]（即 NNNN∈[1,2000]）。 */
  initFactor?: number;

  /** 锁定止损系数（仅 phase_lock）。留空=0.999；量化后范围 (0,2.0]（即 NNNN∈[1,2000]）。 */
  lockFactor?: number;

  /** 初始止损回看根数（仅 phase_lock）。留空=10；正整数。 */
  lookback?: number;

  /**
   * 标的池：
   * - `{type:'all'}`：全市场 A 股。
   * - `{type:'list', tsCodes: [...] }`：指定标的列表（非空）。
   */
  universe: SignalTestUniverse;

  /** 统计区间起始日，YYYYMMDD，须在 trade_cal 覆盖范围内且 ≤ dateEnd。 */
  dateStart: string;

  /** 统计区间结束日，YYYYMMDD，须在 trade_cal 覆盖范围内且 ≥ dateStart。 */
  dateEnd: string;

  /**
   * 迷你回测配置（可选）；缺省 / null = 不跑回测层（信号质量层零漂移，spec 02 §2.1）。
   * 扁平单源 PortfolioSimConfig（spec 03 §3.2）；service 层 fail-fast 校验区间/枚举/anchorMode
   * （spec 04 §4.6，复用 portfolio-sim 语义）；runner 组装成引擎 PortfolioSimConfig{ sources:[{...}] }。
   */
  backtestConfig?: SignalTestBacktestConfig | null;
}
