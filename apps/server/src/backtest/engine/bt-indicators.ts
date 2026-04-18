/**
 * 近期高低价计算工具 — 精确翻译自 backtest/indicators.py
 */

import { KlineBarRow } from './models';

/**
 * 预计算全量 KDJ，用于自定义周期（kdjN/M1/M2 != 9/3/3）时替换行内预存值。
 * 返回 symbol → KDJ 数组（与 df 下标一一对应）。
 */
export function precomputeAllKdj(
  data: Map<string, KlineBarRow[]>,
  n: number,
  m1: number,
  m2: number,
): Map<string, Array<{ k: number; d: number; j: number }>> {
  const result = new Map<string, Array<{ k: number; d: number; j: number }>>();
  for (const [symbol, df] of data) {
    const arr: Array<{ k: number; d: number; j: number }> = new Array(df.length);
    let k = 50, d = 50;
    for (let i = 0; i < df.length; i++) {
      const start = Math.max(0, i - n + 1);
      let highN = -Infinity, lowN = Infinity;
      for (let s = start; s <= i; s++) {
        if (df[s].high > highN) highN = df[s].high;
        if (df[s].low < lowN) lowN = df[s].low;
      }
      const rsv = highN === lowN ? 50 : ((df[i].close - lowN) / (highN - lowN)) * 100;
      k = ((m1 - 1) * k + rsv) / m1;
      d = ((m2 - 1) * d + k) / m2;
      arr[i] = { k, d, j: 3 * k - 2 * d };
    }
    result.set(symbol, arr);
  }
  return result;
}

/**
 * 买入点 entryIdx 的近期低价（止损基准）
 * @param window  向前取最近 N 根 K 线的极值作为初始候选
 * @param buffer  在 window 之外继续向前追溯，找更低的连续低点
 */
export function calcRecentLow(
  df: KlineBarRow[],
  entryIdx: number,
  window: number,
  buffer: number,
): [number, string] {
  const winEnd = entryIdx;
  const winStart = Math.max(0, entryIdx - window);

  if (winStart >= winEnd) {
    return [df[entryIdx]?.low ?? 0, String(df[entryIdx]?.open_time ?? '')];
  }

  const sub = df.slice(winStart, winEnd);
  let recent = Infinity;
  let bestIdx = winStart;
  for (let i = 0; i < sub.length; i++) {
    if (sub[i].low < recent) {
      recent = sub[i].low;
      bestIdx = winStart + i;
    }
  }

  const limit = Math.max(0, entryIdx - buffer);
  let idx = winStart - 1;
  while (idx >= limit) {
    const v = df[idx].low;
    if (v < recent) {
      recent = v;
      bestIdx = idx;
      idx--;
    } else {
      break;
    }
  }

  return [recent, String(df[bestIdx]?.open_time ?? '')];
}

/**
 * 买入点 entryIdx 的近期高价（阶段止盈触发价）
 * @param window  向前取最近 N 根 K 线的极值作为初始候选
 * @param buffer  在 window 之外继续向前追溯，找更高的连续高点
 */
export function calcRecentHigh(
  df: KlineBarRow[],
  entryIdx: number,
  window: number,
  buffer: number,
): [number, string] {
  const winEnd = entryIdx;
  const winStart = Math.max(0, entryIdx - window);

  if (winStart >= winEnd) {
    return [df[entryIdx]?.high ?? 0, String(df[entryIdx]?.open_time ?? '')];
  }

  const sub = df.slice(winStart, winEnd);
  let recent = -Infinity;
  let bestIdx = winStart;
  for (let i = 0; i < sub.length; i++) {
    if (sub[i].high > recent) {
      recent = sub[i].high;
      bestIdx = winStart + i;
    }
  }

  const limit = Math.max(0, entryIdx - buffer);
  let idx = winStart - 1;
  while (idx >= limit) {
    const v = df[idx].high;
    if (v > recent) {
      recent = v;
      bestIdx = idx;
      idx--;
    } else {
      break;
    }
  }

  return [recent, String(df[bestIdx]?.open_time ?? '')];
}
