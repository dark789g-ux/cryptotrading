/**
 * 近期高低价计算工具 — 精确翻译自 backtest/indicators.py
 */

import { KlineBarRow } from './models';

const RECENT_WINDOW = 9;

/**
 * 买入点 entryIdx 的近期低价（止损基准）
 * 翻译自 Python calc_recent_low()
 */
export function calcRecentLow(
  df: KlineBarRow[],
  entryIdx: number,
  lookbackBuffer: number,
): [number, string] {
  const winEnd = entryIdx;
  const winStart = Math.max(0, entryIdx - RECENT_WINDOW);

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

  const limit = Math.max(0, entryIdx - lookbackBuffer);
  let idx = winStart - 1;
  while (idx >= limit) {
    const v = df[idx].low;
    if (v <= recent) {
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
 * 翻译自 Python calc_recent_high()
 */
export function calcRecentHigh(
  df: KlineBarRow[],
  entryIdx: number,
  lookbackBuffer: number,
): [number, string] {
  const winEnd = entryIdx;
  const winStart = Math.max(0, entryIdx - RECENT_WINDOW);

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

  const limit = Math.max(0, entryIdx - lookbackBuffer);
  let idx = winStart - 1;
  while (idx >= limit) {
    const v = df[idx].high;
    if (v >= recent) {
      recent = v;
      bestIdx = idx;
      idx--;
    } else {
      break;
    }
  }

  return [recent, String(df[bestIdx]?.open_time ?? '')];
}
