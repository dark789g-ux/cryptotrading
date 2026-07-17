/**
 * derived-field-kdj.recomputer.ts
 *
 * KDJ 自定义参数现算重算器。Adapter 模式:复用已有 KdjRecomputeService
 * (从 raw.daily_quote 读 qfq HLC,内存算 KDJ),适配到 DerivedFieldRecomputer 接口。
 *
 * needsRecompute 判定:field 是 kdj_j/kdj_k/kdj_d 之一,且带 kdjParams(自定义参数)。
 * 不带 kdjParams 的走预算列 i.kdj_j(库内 9/3/3)。
 */

import { Injectable, Logger } from '@nestjs/common';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';
import {
  DerivedFieldRecomputer,
  DerivedFieldSnapshot,
} from './derived-field-registry';
import { KdjRecomputeService } from './kdj-recompute.service';
import { evalKdjCondition } from './kdj-condition-eval';
import { isKdjField, isCustomKdjParams, isValidKdjParams } from './kdj-params';

@Injectable()
export class KdjFieldRecomputer
  implements DerivedFieldRecomputer<{ k: number; d: number; j: number }>
{
  private readonly logger = new Logger(KdjFieldRecomputer.name);
  readonly name = 'KdjFieldRecomputer';

  constructor(private readonly kdjRecompute: KdjRecomputeService) {}

  needsRecompute(cond: StrategyConditionItem): boolean {
    if (!isKdjField(cond.field) || !isCustomKdjParams(cond.kdjParams)) {
      return false;
    }
    if (!isValidKdjParams(cond.kdjParams!)) {
      this.logger.warn(
        `非法自定义 KDJ 参数,回退 9/3/3:field=${cond.field} ` +
          `kdjParams=${JSON.stringify(cond.kdjParams)}`,
      );
      return false;
    }
    return true;
  }

  async recomputeLatest(
    tsCodes: string[],
    asOfDate: string,
    cond: StrategyConditionItem,
  ): Promise<
    Map<string, DerivedFieldSnapshot<{ k: number; d: number; j: number }>>
  > {
    const params = cond.kdjParams!;
    const raw = await this.kdjRecompute.recomputeLatest(
      tsCodes,
      asOfDate,
      params,
    );
    // 适配 KdjRecomputeResult → DerivedFieldSnapshot(结构兼容)
    const out = new Map<
      string,
      DerivedFieldSnapshot<{ k: number; d: number; j: number }>
    >();
    for (const [tsCode, recomp] of raw) {
      out.set(tsCode, { curr: recomp.curr, prev: recomp.prev });
    }
    return out;
  }

  evaluate(
    cond: StrategyConditionItem,
    result: DerivedFieldSnapshot<{ k: number; d: number; j: number }>,
  ): boolean {
    // KdjRecomputeResult 与 DerivedFieldSnapshot 结构兼容(curr/prev)
    return evalKdjCondition(cond, {
      curr: result.curr,
      prev: result.prev,
    });
  }
}
