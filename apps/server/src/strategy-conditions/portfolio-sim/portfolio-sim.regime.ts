/**
 * portfolio-sim.regime.ts
 *
 * regime 求值器（纯函数，零 DB）。spec §5。
 *
 * 按当日大盘 0AMV bar 评估 regime 规则：每条 RegimeRule 的 conditions 内部 AND，
 * 按列表顺序「首个全条件命中」生效，覆盖 maxPositions/positionRatio。
 * 全程 fail-closed：bar 缺失 / 引用字段 NULL / 未知字段 / 不支持的算子 → 该条件 false → 该 rule 落空。
 *
 * StrategyConditionItem = {field, operator, value?, compareField?}（后端形态，**无 compareMode**）：
 * value vs 字段比较靠 compareField 是否存在区分（同 strategy-conditions.query-builder.ts:138 既有口径）。
 */

import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';
import { OamvBar, RegimeRule } from './portfolio-sim.types';

/** 前端 0AMV 字段名 → OamvBar 属性名（5 个白名单字段）。 */
const OAMV_FIELD_MAP: Record<string, keyof OamvBar> = {
  oamv_dif: 'amvDif',
  oamv_dea: 'amvDea',
  oamv_macd: 'amvMacd',
  oamv_close: 'close',
  oamv_ma240: 'ma240',
};

/** 数值比较算子表（与 query-builder COMPARISON_OPERATORS 同集；cross_* 不在内）。 */
const COMPARATORS: Record<string, (a: number, b: number) => boolean> = {
  gt: (a, b) => a > b,
  gte: (a, b) => a >= b,
  lt: (a, b) => a < b,
  lte: (a, b) => a <= b,
  eq: (a, b) => a === b,
  neq: (a, b) => a !== b,
};

/**
 * 取 bar 上某前端字段的值；未知字段 → null。
 */
function fieldValue(bar: OamvBar, field: string): number | null {
  const prop = OAMV_FIELD_MAP[field];
  if (prop === undefined) return null; // 未知字段 → fail-closed
  return bar[prop];
}

/**
 * 评估单条 0AMV 条件（fail-closed）。
 *
 *   lhs = bar[map[field]]；未知字段 / lhs==null → false
 *   rhs = compareField 存在 ? bar[map[compareField]] : value；
 *         未知 compareField / rhs==null → false
 *   operator ∈ {gt,lt,gte,lte,eq,neq} → 数值比较；其它（cross_*）→ false
 */
export function evalOamvCondition(cond: StrategyConditionItem, bar: OamvBar): boolean {
  const cmp = COMPARATORS[cond.operator];
  if (cmp === undefined) return false; // cross_above/cross_below 等不支持 → fail-closed

  const lhs = fieldValue(bar, cond.field);
  if (lhs === null) return false; // 未知字段 / 引用列 NULL → fail-closed

  let rhs: number | null;
  if (cond.compareField != null) {
    rhs = fieldValue(bar, cond.compareField); // 字段 vs 字段
  } else {
    rhs = typeof cond.value === 'number' ? cond.value : null; // 字段 vs 常量
  }
  if (rhs === null) return false; // 缺值 / 未知 compareField / 比较列 NULL → fail-closed

  return cmp(lhs, rhs);
}

/**
 * 解析当日 regime（spec §5）。
 *
 *   bar == null（缺数据）→ null（fail-closed，调用方据此当天不开仓）
 *   逐 rule：conditions.every(命中)（全 AND）；首个命中返回其 {maxPositions, positionRatio}
 *   无命中 → null
 */
export function resolveRegime(
  bar: OamvBar | null,
  regimes: RegimeRule[],
): { maxPositions: number; positionRatio: number } | null {
  if (!bar) return null;
  for (const rule of regimes) {
    if (rule.conditions.every((c) => evalOamvCondition(c, bar))) {
      return { maxPositions: rule.maxPositions, positionRatio: rule.positionRatio };
    }
  }
  return null;
}
