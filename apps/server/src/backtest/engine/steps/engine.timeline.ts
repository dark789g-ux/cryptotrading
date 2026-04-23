import type { KlineBarRow } from '../models';

export function buildGlobalTimeline(
  data: Map<string, KlineBarRow[]>,
  backtestStart: Map<string, number>,
): string[] {
  const times = new Set<string>();
  for (const [symbol, df] of data) {
    const bstart = backtestStart.get(symbol) ?? 0;
    for (let i = bstart; i < df.length; i++) {
      times.add(String(df[i].open_time));
    }
  }
  return Array.from(times).sort();
}
