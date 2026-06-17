/**
 * KDJ 实时重算 —— 纯逻辑 + 共享常量/helper（无 DB 依赖，可独立单测）。
 *
 * 背景：A 股「策略条件」扫描 KDJ 时默认读 DB 预存的 9/3/3 列；当某条 KDJ 条件
 * 带自定义参数（N/M1/M2，如 6/2/2）时，需按这组参数实时重算 KDJ。
 *
 * 公式复用回测引擎已有的纯函数 `precomputeAllKdj`（bt-indicators.ts），
 * 不在此重复实现 KDJ 公式，保证与回测口径一致。
 */

import { precomputeAllKdj } from '../backtest/engine/bt-indicators';
import { KlineBarRow } from '../backtest/engine/models';

/** KDJ 在策略条件 field 体系中的字段键。 */
export const KDJ_FIELD_KEYS = ['kdj_j', 'kdj_k', 'kdj_d'] as const;

/** KDJ 默认参数（通达信标准 9/3/3）。 */
export const DEFAULT_KDJ_PARAMS = { n: 9, m1: 3, m2: 3 };

export interface KdjParams {
  n: number;
  m1: number;
  m2: number;
}

/** field 是否属于 KDJ 三键之一。 */
export function isKdjField(field: string): boolean {
  return (KDJ_FIELD_KEYS as readonly string[]).includes(field);
}

/**
 * 参数是否为自定义（≠ 9/3/3）。
 * - 缺省（undefined）→ false（用默认列）
 * - n/m1/m2 任一不等于 9/3/3 → true
 * - 全等 9/3/3 → false
 */
export function isCustomKdjParams(p?: KdjParams): boolean {
  if (!p) return false;
  return (
    p.n !== DEFAULT_KDJ_PARAMS.n ||
    p.m1 !== DEFAULT_KDJ_PARAMS.m1 ||
    p.m2 !== DEFAULT_KDJ_PARAMS.m2
  );
}

/** 单条序列重算 KDJ 所需的最小行（仅 high/low/close）。 */
export interface KdjBar {
  high: number;
  low: number;
  close: number;
}

interface KdjPoint {
  k: number;
  d: number;
  j: number;
}

/**
 * 对一条按 trade_date 升序的序列，复用 `precomputeAllKdj` 算出整条 KDJ，
 * 返回最后一根（curr）与倒数第二根（prev，不足两根则 null）。
 *
 * precomputeAllKdj 内部仅读每根的 `.high/.low/.close`，因此把 KdjBar 投影为
 * 仅含这三个字段的对象喂入即可（其余 KlineBarRow 字段不参与计算）。
 */
export function lastTwoKdj(
  bars: KdjBar[],
  n: number,
  m1: number,
  m2: number,
): { curr: KdjPoint; prev: KdjPoint | null } {
  if (bars.length === 0) {
    throw new Error('lastTwoKdj: bars 不得为空');
  }

  // precomputeAllKdj 只读 high/low/close；用类型安全投影后断言为 KlineBarRow。
  const projected: KlineBarRow[] = bars.map(
    (b) => ({ high: b.high, low: b.low, close: b.close }) as unknown as KlineBarRow,
  );

  const arr = precomputeAllKdj(new Map([['_', projected]]), n, m1, m2).get('_')!;

  const last = arr.length - 1;
  const curr: KdjPoint = arr[last];
  const prev: KdjPoint | null = last >= 1 ? arr[last - 1] : null;
  return { curr, prev };
}
