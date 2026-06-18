/**
 * KDJ 纯函数 —— 通达信标准公式，与回测引擎 precomputeAllKdj 算法一致。
 * 无 DB / 无外部依赖，只读取每根 high/low/close，便于单测与复用。
 */

export interface KdjInputBar {
  high: number;
  low: number;
  close: number;
}

export interface KdjPoint {
  k: number;
  d: number;
  j: number;
}

/** KDJ 默认参数（通达信标准 9/3/3）。 */
export const DEFAULT_KDJ_PARAMS = { n: 9, m1: 3, m2: 3 };

/** 对单点 KDJ 值做 4 位小数取整，与 DB 预存列精度保持一致。 */
export function roundKdjPoint(p: KdjPoint): KdjPoint {
  return {
    k: parseFloat(p.k.toFixed(4)),
    d: parseFloat(p.d.toFixed(4)),
    j: parseFloat(p.j.toFixed(4)),
  };
}

/**
 * 参数是否为自定义（≠ 9/3/3）。
 * - 缺省（undefined）→ false（用默认列）
 * - n/m1/m2 任一不等于 9/3/3 → true
 * - 全等 9/3/3 → false
 */
export function isCustomKdjParams(p?: { n: number; m1: number; m2: number }): boolean {
  if (!p) return false;
  return (
    p.n !== DEFAULT_KDJ_PARAMS.n ||
    p.m1 !== DEFAULT_KDJ_PARAMS.m1 ||
    p.m2 !== DEFAULT_KDJ_PARAMS.m2
  );
}

/**
 * 计算整条 KDJ 序列。
 *
 * 公式（通达信标准）：
 *   RSV = (close - N 日 low) / (N 日 high - N 日 low) * 100
 *   K = (M1-1)/M1 * prevK + 1/M1 * RSV
 *   D = (M2-1)/M2 * prevD + 1/M2 * K
 *   J = 3K - 2D
 *
 * 首根 K/D 种子为 50；前 N-1 根因窗口不足仍按 50/50 种子递推，
 * 与现有 precomputeAllKdj / calcIndicators 行为一致。
 */
export function calcKdjSeries(
  bars: KdjInputBar[],
  n: number,
  m1: number,
  m2: number,
): KdjPoint[] {
  const result: KdjPoint[] = new Array(bars.length);
  let k = 50;
  let d = 50;

  for (let i = 0; i < bars.length; i++) {
    const start = Math.max(0, i - n + 1);
    let highN = -Infinity;
    let lowN = Infinity;

    for (let s = start; s <= i; s++) {
      if (bars[s].high > highN) highN = bars[s].high;
      if (bars[s].low < lowN) lowN = bars[s].low;
    }

    const rsv = highN === lowN ? 50 : ((bars[i].close - lowN) / (highN - lowN)) * 100;
    k = ((m1 - 1) * k + rsv) / m1;
    d = ((m2 - 1) * d + k) / m2;
    result[i] = { k, d, j: 3 * k - 2 * d };
  }

  return result;
}
