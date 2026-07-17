/**
 * derived-field-ma.recomputer.ts
 *
 * MA 任意周期现算重算器。处理 field 形如 `ma20`/`ma10`/`ma15` 的条件。
 *
 * needsRecompute 判定:field 匹配 /^ma(\d+)$/ 且该周期不在 ASHARE_FIELD_COL_MAP
 * (即 ma5/30/60/120/240 走预算列,其它周期现算)。
 */

import { Injectable } from '@nestjs/common';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';
import {
  DerivedFieldRecomputer,
  DerivedFieldSnapshot,
} from './derived-field-registry';
import { DerivedFieldRecomputeService } from './derived-field-recompute.service';
import { ASHARE_FIELD_COL_MAP } from './strategy-conditions.types';
import { calcStrictSma } from '../indicators/indicators';

const MA_FIELD_RE = /^ma(\d+)$/;

export interface MaSnapshot {
  ma: number | null;
}

/** 比较算子表(与 kdj-condition-eval.ts COMPARATORS 一致) */
const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

@Injectable()
export class MaFieldRecomputer implements DerivedFieldRecomputer<MaSnapshot> {
  readonly name = 'MaFieldRecomputer';

  constructor(
    private readonly recomputeService: DerivedFieldRecomputeService,
  ) {}

  needsRecompute(cond: StrategyConditionItem): boolean {
    const m = cond.field.match(MA_FIELD_RE);
    if (!m) return false;
    // 已在 COL_MAP 的(ma5/30/60/120/240)走 SQL;其它周期现算
    return !ASHARE_FIELD_COL_MAP[cond.field];
  }

  async recomputeLatest(
    tsCodes: string[],
    asOfDate: string,
    cond: StrategyConditionItem,
  ): Promise<Map<string, DerivedFieldSnapshot<MaSnapshot>>> {
    const period = parseInt(cond.field.match(MA_FIELD_RE)![1], 10);
    const barsMap = await this.recomputeService.loadQfqBars(
      tsCodes,
      asOfDate,
      period,
    );
    const out = new Map<string, DerivedFieldSnapshot<MaSnapshot>>();
    for (const [tsCode, bars] of barsMap) {
      if (bars.length < period) {
        // warmup 不足:curr=null(条件不命中,fail-closed)
        out.set(tsCode, { curr: { ma: null }, prev: null });
        continue;
      }
      const closes = bars.map((b) => b.close);
      // curr:最后 period 根的 SMA
      const currArr = calcStrictSma(closes, period);
      const currMa = currArr[currArr.length - 1] ?? null;
      // prev:倒数第 period+1 根到倒数第 2 根的 SMA(需至少 period+1 根)
      let prevMa: number | null = null;
      if (closes.length > period) {
        const prevCloses = closes.slice(0, -1);
        const prevArr = calcStrictSma(prevCloses, period);
        prevMa = prevArr[prevArr.length - 1] ?? null;
      }
      out.set(tsCode, {
        curr: { ma: currMa },
        prev: typeof prevMa === 'number' ? { ma: prevMa } : null,
      });
    }
    return out;
  }

  evaluate(
    cond: StrategyConditionItem,
    result: DerivedFieldSnapshot<MaSnapshot>,
    siblingResults?: Map<string, DerivedFieldSnapshot<MaSnapshot>>,
  ): boolean {
    const { operator, value, compareField } = cond;
    const lhsCurr = result.curr.ma;
    // curr=null(warmup 不足)→ false(fail-closed)
    if (lhsCurr === null) return false;

    // cross_above / cross_below
    if (operator === 'cross_above' || operator === 'cross_below') {
      if (result.prev === null || result.prev.ma === null) return false;
      const lhsPrev = result.prev.ma;

      let rhsPrev: number | undefined;
      let rhsCurr: number | undefined;
      if (compareField && siblingResults) {
        const sibling = siblingResults.get(compareField);
        if (!sibling) return false; // sibling 缺失,无法比较
        if (sibling.prev === null || sibling.prev.ma === null) return false; // sibling 无前一日值
        rhsPrev = sibling.prev.ma;
        rhsCurr = sibling.curr.ma ?? undefined;
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

    // 比较类:gt/gte/lt/lte/eq/neq
    const cmp = COMPARATORS[operator];
    if (!cmp) return false;

    const rhs = compareField
      ? siblingResults?.get(compareField)?.curr.ma
      : value;
    if (rhs === undefined || rhs === null) return false;

    return cmp(lhsCurr, rhs);
  }
}
