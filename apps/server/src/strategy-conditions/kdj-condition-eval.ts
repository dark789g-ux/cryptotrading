/**
 * KDJ 条件纯求值（in-memory，无 DB 依赖，可独立单测）。
 *
 * 背景：A 股「策略条件」扫描中，带自定义 KDJ 参数（N/M1/M2 ≠ 9/3/3）的条件无法走
 * 预存列 SQL，需先用 `KdjRecomputeService` 实时重算出每个标的的 {curr, prev}，再用本
 * 模块按该条件对重算结果求值。求值语义严格对齐 `strategy-conditions.query-builder.ts`
 * 的比较/上穿下穿翻译，保证重算路径与默认 9/3/3 SQL 路径口径一致。
 */

import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';

/** KDJ 三线的某一根快照。 */
interface KdjPoint {
  k: number;
  d: number;
  j: number;
}

/** 单标的 as-of 重算结果：当日 curr + 前一交易日 prev（不足两根则 null）。 */
export interface KdjRecomp {
  curr: KdjPoint;
  prev: KdjPoint | null;
}

/** 'kdj_k'→'k'、'kdj_d'→'d'、'kdj_j'→'j'。 */
export function kdjLineOf(field: string): 'k' | 'd' | 'j' {
  switch (field) {
    case 'kdj_k':
      return 'k';
    case 'kdj_d':
      return 'd';
    case 'kdj_j':
      return 'j';
    default:
      throw new Error(`kdjLineOf: 非 KDJ 字段 "${field}"`);
  }
}

const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

/**
 * 对一条 KDJ 条件，用其重算结果求值。
 *
 * - 比较类（gt/gte/lt/lte/eq/neq）：右值 = compareField 时取 curr 对应线，否则取 cond.value；
 *   右值为 undefined（既无 compareField 又无 value）→ false。
 * - cross 类（cross_above/cross_below）：prev==null → false；
 *   右侧 prev/curr = compareField 时取 prev/curr 对应线，否则同一常量 value；
 *   cross_above = prevLhs < prevRhs && currLhs > currRhs；
 *   cross_below = prevLhs > prevRhs && currLhs < currRhs（严格不等号，沿用 query-builder）。
 */
export function evalKdjCondition(cond: StrategyConditionItem, recomp: KdjRecomp): boolean {
  const { field, operator, value, compareField } = cond;
  const line = kdjLineOf(field);
  const lhsCurr = recomp.curr[line];

  if (operator === 'cross_above' || operator === 'cross_below') {
    if (recomp.prev === null) return false;
    const lhsPrev = recomp.prev[line];

    let rhsPrev: number | undefined;
    let rhsCurr: number | undefined;
    if (compareField) {
      const cmpLine = kdjLineOf(compareField);
      rhsPrev = recomp.prev[cmpLine];
      rhsCurr = recomp.curr[cmpLine];
    } else {
      rhsPrev = value;
      rhsCurr = value;
    }
    if (rhsPrev === undefined || rhsCurr === undefined) return false;

    if (operator === 'cross_above') {
      return lhsPrev < rhsPrev && lhsCurr > rhsCurr;
    }
    return lhsPrev > rhsPrev && lhsCurr < rhsCurr;
  }

  const cmp = COMPARATORS[operator];
  if (!cmp) return false;

  const rhs = compareField ? recomp.curr[kdjLineOf(compareField)] : value;
  if (rhs === undefined) return false;

  return cmp(lhsCurr, rhs);
}
