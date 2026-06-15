/**
 * portfolio-sim.regime-validator.ts
 *
 * 共享 regime 校验器（DTO 层，fail-fast，spec §7）。两处复用同一 validateRegimes：
 *   - 组合模拟 create dto（config.regimes，tag='config.regimes'）
 *   - 迷你回测 validateBacktestConfig（backtestConfig.regimes，tag='backtestConfig.regimes'）
 *
 * 规则（spec §7）：
 *   每条 RegimeRule：
 *     conditions   非空数组；每项 field ∈ 5 个 0AMV 字段白名单；
 *                  operator ∈ {gt,lt,gte,lte,eq,neq}（禁 cross_above/cross_below）；
 *                  有 compareField → 它也在白名单；否则 value 须为有限数
 *                  （后端 StrategyConditionItem 无 compareMode，靠 compareField 存在性区分）。
 *     maxPositions 正整数（有限，无「不限仓 null」档——刻意收窄）。
 *     positionRatio (0,1]。
 *   非法 → 中文 400（BadRequestException），消息含 tag 前缀。
 *
 * 注：anchorMode=true 且配了 regimes 仍允许保存（运行时引擎静默旁路），本校验不涉锚点。
 */

import { BadRequestException } from '@nestjs/common';
import { RegimeRule } from './portfolio-sim.types';

/** 5 个 0AMV 字段白名单（与 portfolio-sim.regime.ts OAMV_FIELD_MAP 键集、ASHARE_MARKET_AMV_COL_MAP 键集一致）。 */
const OAMV_FIELD_WHITELIST = new Set<string>([
  'oamv_dif',
  'oamv_dea',
  'oamv_macd',
  'oamv_close',
  'oamv_ma240',
]);

/** 允许的数值比较算子（与求值器 COMPARATORS 同集；禁 cross_above/cross_below）。 */
const REGIME_OPERATOR_WHITELIST = new Set<string>(['gt', 'lt', 'gte', 'lte', 'eq', 'neq']);

/**
 * 校验 regimes（两处 config 共用）。缺省 / null → 不校验（零漂移）；空数组合法（= 不启用）。
 *
 * @param regimes 待校验的 regime 规则列表（可空）
 * @param tag     消息前缀（'config.regimes' 或 'backtestConfig.regimes'）
 */
export function validateRegimes(
  regimes: RegimeRule[] | null | undefined,
  tag: string,
): void {
  if (regimes === undefined || regimes === null) return;
  if (!Array.isArray(regimes)) {
    throw new BadRequestException(`${tag} 须为数组`);
  }

  for (let i = 0; i < regimes.length; i++) {
    const rule = regimes[i];
    const rtag = `${tag}[${i}]`;
    if (!rule || typeof rule !== 'object') {
      throw new BadRequestException(`${rtag} 非法`);
    }

    // conditions：非空数组，每项 field/operator/value/compareField 校验。
    const conditions = rule.conditions;
    if (!Array.isArray(conditions) || conditions.length === 0) {
      throw new BadRequestException(`${rtag}.conditions 须为非空数组`);
    }
    for (let j = 0; j < conditions.length; j++) {
      const c = conditions[j];
      const ctag = `${rtag}.conditions[${j}]`;
      if (!c || typeof c !== 'object') {
        throw new BadRequestException(`${ctag} 非法`);
      }
      if (!OAMV_FIELD_WHITELIST.has(c.field)) {
        throw new BadRequestException(
          `${ctag}.field 非法：${String(c.field)}（须为 0AMV 字段 oamv_dif/oamv_dea/oamv_macd/oamv_close/oamv_ma240）`,
        );
      }
      if (!REGIME_OPERATOR_WHITELIST.has(c.operator)) {
        throw new BadRequestException(
          `${ctag}.operator 非法：${String(c.operator)}（须为 gt/lt/gte/lte/eq/neq，禁 cross_above/cross_below）`,
        );
      }
      if (c.compareField !== undefined && c.compareField !== null) {
        if (!OAMV_FIELD_WHITELIST.has(c.compareField)) {
          throw new BadRequestException(
            `${ctag}.compareField 非法：${String(c.compareField)}（须为 0AMV 字段白名单内）`,
          );
        }
      } else if (typeof c.value !== 'number' || !Number.isFinite(c.value)) {
        throw new BadRequestException(`${ctag}.value 须为有限数（或提供 compareField 作字段比较）`);
      }
    }

    // maxPositions：正整数（无 null「不限仓」档）。
    if (!Number.isInteger(rule.maxPositions) || (rule.maxPositions as number) < 1) {
      throw new BadRequestException(`${rtag}.maxPositions 须为 ≥1 的整数`);
    }

    // positionRatio：(0,1]。
    if (
      typeof rule.positionRatio !== 'number' ||
      !(rule.positionRatio > 0) ||
      rule.positionRatio > 1
    ) {
      throw new BadRequestException(`${rtag}.positionRatio 须在 (0, 1] 区间`);
    }
  }
}
