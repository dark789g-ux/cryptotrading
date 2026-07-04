import { WindowQuote } from '../core/exit-simulator';

const MA5_WINDOW = 5;
const MA5_PREHEAT_TRADING_DAYS = 4;

function toNum(v: string | null | undefined): number | null {
  if (v === null || v === undefined) return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
}

export function attachMa5(
  dates: string[],
  quoteMap: Map<string, WindowQuote>,
  win: number = MA5_WINDOW,
): void {
  const buf: number[] = [];
  let sum = 0;
  for (const d of dates) {
    const q = quoteMap.get(d);
    if (!q || q.qfqClose === null) continue;
    buf.push(q.qfqClose);
    sum += q.qfqClose;
    if (buf.length > win) sum -= buf.shift()!;
    q.ma5 = buf.length === win ? sum / win : null;
  }
}

export function collectRecentLows(
  sseCalendar: string[],
  buyIdx: number,
  quoteMap: Map<string, WindowQuote>,
  lookback: number,
): number[] {
  const lowsDesc: number[] = [];
  for (let i = buyIdx; i >= 0 && lowsDesc.length < lookback; i--) {
    const q = quoteMap.get(sseCalendar[i]);
    if (!q || q.qfqLow === null || q.qfqLow === undefined) continue;
    lowsDesc.push(q.qfqLow);
  }
  return lowsDesc.reverse();
}

export { toNum, MA5_WINDOW, MA5_PREHEAT_TRADING_DAYS };
