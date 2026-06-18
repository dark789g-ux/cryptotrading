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
