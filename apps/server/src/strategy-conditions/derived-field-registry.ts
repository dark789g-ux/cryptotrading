/**
 * derived-field-registry.ts
 *
 * 通用 derived field(现算字段)注册表。把 KDJ 自定义参数这种"现算"模式
 * 泛化为可注册的抽象,后续加 MA 任意周期、RSI 等只需注册新 recomputer。
 *
 * 设计契约见 docs/design_rules/regime-backtest/03-engine-internals.md §1-§2。
 *
 * 消费方(StrategyConditionsRunner / SignalEnumerator / ExitSignalLoader)通过
 * registry.split(conditions) 把条件拆成 sqlConds(走预算 DB 列)+ recompConds(现算),
 * Phase 1 SQL 筛候选集,Phase 2 对候选集逐 ts_code 用 recomputer.recomputeLatest +
 * evaluate 做内存过滤。
 */

import { Injectable } from '@nestjs/common';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';

/** 单个现算字段的重算结果:curr/prev 两帧(prev 可为 null,cross 类条件需用) */
export interface DerivedFieldSnapshot<T = unknown> {
  curr: T;
  prev: T | null;
}

/** 单个现算字段的重算器接口(泛化自 KdjRecomputeService) */
export interface DerivedFieldRecomputer<TResult = unknown> {
  /** 该重算器的人类可读名(日志/调试用) */
  readonly name: string;

  /** 判断条件是否需要本重算器处理(返回 true 则进 recompConds,否则进 sqlConds) */
  needsRecompute(cond: StrategyConditionItem): boolean;

  /** 批量重算,返回每个 ts_code 的 curr + prev 两帧。asOfDate 为回测当日(YYYYMMDD) */
  recomputeLatest(
    tsCodes: string[],
    asOfDate: string,
    cond: StrategyConditionItem,
  ): Promise<Map<string, DerivedFieldSnapshot<TResult>>>;

  /** 内存求值单条件(支持 value/field/cross_above/cross_below)。siblingResults 用于 compareMode=field */
  evaluate(
    cond: StrategyConditionItem,
    result: DerivedFieldSnapshot<TResult>,
    siblingResults?: Map<string, DerivedFieldSnapshot<TResult>>,
  ): boolean;
}

@Injectable()
export class DerivedFieldRegistry {
  private recomputers: DerivedFieldRecomputer[] = [];

  /** 注册一个重算器(module onModuleInit 时调用) */
  register(recomputer: DerivedFieldRecomputer): void {
    this.recomputers.push(recomputer);
  }

  /** 找到能处理该条件的重算器;无则返回 null(走纯 SQL) */
  resolve(cond: StrategyConditionItem): DerivedFieldRecomputer | null {
    return this.recomputers.find((r) => r.needsRecompute(cond)) ?? null;
  }

  /** 拆分条件数组为 sqlConds + recompConds */
  split(conditions: StrategyConditionItem[]): {
    sqlConds: StrategyConditionItem[];
    recompConds: StrategyConditionItem[];
  } {
    const sqlConds: StrategyConditionItem[] = [];
    const recompConds: StrategyConditionItem[] = [];
    for (const c of conditions) {
      if (this.resolve(c)) recompConds.push(c);
      else sqlConds.push(c);
    }
    return { sqlConds, recompConds };
  }

  /** 判断一组条件是否含现算字段(消费方决定是否触发 Phase 2) */
  hasRecomputeNeeds(conditions: StrategyConditionItem[]): boolean {
    return conditions.some((c) => this.resolve(c) !== null);
  }
}
