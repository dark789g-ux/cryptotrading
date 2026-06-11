/**
 * portfolio-sim.loader-helpers.ts
 *
 * 装载层的纯辅助函数（不依赖 DB / NestJS），抽出以便单测：
 *   - parseNumericString：TypeORM numeric（pg 返回 string）→ number，统一 parseFloat。
 *   - qfqRatioBar：由 qfq_open/qfq_close 构造引擎 EngineQuoteBar（引擎只用比率，任意一致缩放均可）。
 *   - extendCalendarTail：日历末端落后于 trades 最大日期时，用 trades buy/exit 日期并集补尾。
 *   - windowUnionByTsCode：按 tsCode 聚合其全部持有窗口并集 [min(buyDate), max(exitDate)]。
 *
 * 口径基准：W2 loader spec（02 引擎设计相关段）。
 */

import { EngineQuoteBar, EngineTrade } from './portfolio-sim.types';

/** 装载层从 DB 取出的一笔原始 trade 行（numeric/字段均以 pg 原始形态）。 */
export interface RawTradeRow {
  tsCode: string;
  signalDate: string;
  buyDate: string;
  exitDate: string;
  /** numeric → string（pg）。 */
  ret: string;
  holdDays: number;
}

/**
 * TypeORM numeric（pg 以 string 返回）统一转 number。
 * null/undefined/空串/非有限 → null（调用方按业务决定是否兜底）。
 */
export function parseNumericString(v: string | null | undefined): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = parseFloat(v);
  return Number.isFinite(n) ? n : null;
}

/**
 * 由 qfq_open / qfq_close 构造 EngineQuoteBar。
 *
 * 引擎盯市只用**比率**（close/open、close/上一 close），每股任意一致缩放均可，
 * 故直接用前复权 qfq 价（同股内一致缩放）即可，无需归一到最新基准。
 *
 * 任一价缺失（停牌行残缺）→ 返回 null，调用方应跳过该日（视同无行情）。
 */
export function qfqRatioBar(
  qfqOpen: string | null | undefined,
  qfqClose: string | null | undefined,
): EngineQuoteBar | null {
  const open = parseNumericString(qfqOpen);
  const close = parseNumericString(qfqClose);
  if (open === null || close === null) return null;
  return { open, close };
}

/**
 * 计算每个 tsCode 的持有窗口并集 [min(buyDate), max(exitDate)]。
 *
 * @param trades 已构造的 EngineTrade（buyDate ≤ exitDate，YYYYMMDD 可字符串比较）
 * @returns Map<tsCode, { minBuy, maxExit }>
 */
export function windowUnionByTsCode(
  trades: EngineTrade[],
): Map<string, { minBuy: string; maxExit: string }> {
  const map = new Map<string, { minBuy: string; maxExit: string }>();
  for (const t of trades) {
    const cur = map.get(t.tsCode);
    if (!cur) {
      map.set(t.tsCode, { minBuy: t.buyDate, maxExit: t.exitDate });
    } else {
      if (t.buyDate < cur.minBuy) cur.minBuy = t.buyDate;
      if (t.exitDate > cur.maxExit) cur.maxExit = t.exitDate;
    }
  }
  return map;
}

/**
 * 日历补尾：若 SSE 日历末端落后于 trades 最大 exitDate，用 trades 的 buy/exit 日期并集补齐缺失尾段。
 *
 * 背景：trade_cal 常滞后于实际成交日期（见仓内 raw 同步分工经验）。若日历不覆盖某 exitDate，
 * 引擎逐日回放就走不到该出场日，持仓永不收口 → 末日 NAV 失真。这里用 trades 自带日期补全。
 *
 * 实现：
 *   - 取 trades 全部 buyDate/exitDate 去重 → 候选日期集。
 *   - 与原日历合并去重、升序。
 *   - 仅补「> 原日历末端」的候选日（中间空洞不补：trade_cal 本身不缺中间交易日，
 *     补中间反而可能引入非交易日；落后只发生在尾端）。
 *
 * @param calendar 原 SSE 升序交易日（可空）
 * @param trades   全部 EngineTrade
 * @returns        { calendar: 补尾后升序日历, appendedDates: 实际补入的日期（升序） }
 */
export function extendCalendarTail(
  calendar: string[],
  trades: EngineTrade[],
): { calendar: string[]; appendedDates: string[] } {
  if (trades.length === 0) return { calendar: [...calendar], appendedDates: [] };

  let maxExit = trades[0].exitDate;
  for (const t of trades) if (t.exitDate > maxExit) maxExit = t.exitDate;

  const calTail = calendar.length > 0 ? calendar[calendar.length - 1] : '';
  // 末端已覆盖 → 无需补。
  if (calTail >= maxExit) return { calendar: [...calendar], appendedDates: [] };

  // 收集 > calTail 的 trades 日期（buy/exit 并集）。
  const extra = new Set<string>();
  for (const t of trades) {
    if (t.buyDate > calTail) extra.add(t.buyDate);
    if (t.exitDate > calTail) extra.add(t.exitDate);
  }
  const appendedDates = Array.from(extra).sort();
  return { calendar: [...calendar, ...appendedDates], appendedDates };
}
