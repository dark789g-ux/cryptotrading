/**
 * create-signal-test.dto.ts
 *
 * 创建信号前向统计方案的请求 DTO。
 * 校验在 service 层 fail-fast（class-validator 未全局启用，统一在 service 抛 BadRequestException）。
 */
import { StrategyConditionItem } from '../../../entities/strategy/strategy-condition.entity';
import { SignalTestUniverse } from '../../../entities/strategy/signal-test.entity';

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
   */
  exitMode: 'fixed_n' | 'strategy' | 'trailing_lock';

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
}
