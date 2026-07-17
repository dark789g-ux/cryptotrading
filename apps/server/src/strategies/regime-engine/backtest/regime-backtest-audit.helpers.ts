import { RegimeBacktestDailyLogEntity } from '../../../entities/strategy/regime-backtest-daily-log.entity';
import { RegimeBacktestTradeEntity } from '../../../entities/strategy/regime-backtest-trade.entity';
import {
  RegimeDailyAuditEntry,
  RegimeDailyAuditExit,
  RegimeDailyAuditRow,
} from './regime-backtest.types';

export interface RegimeBacktestDailyLogDto {
  tradeDate: string;
  nav: number;
  cash: number;
  regime: string;
  frozenReason: string | null;
  tradePhase: string | null;
  entries: RegimeDailyAuditEntry[];
  exits: RegimeDailyAuditExit[];
  openSymbols: string[];
  cooldown: {
    inCooldown: boolean;
    duration: number | null;
    remaining: number | null;
    consecLosses: number;
  };
}

export interface RegimeBacktestPositionRow {
  tsCode: string;
  signalDate: string;
  buyDate: string;
  exitDate: string | null;
  regime: string;
  exitMode: string | null;
  tradePhase: string | null;
  alloc: number | null;
  ret: number | null;
  realizedRetNet: number | null;
  exitReason: string | null;
  costsPaid: number | null;
}

export interface RegimeBacktestSymbolStatRow {
  tsCode: string;
  tradeCount: number;
  winCount: number;
  lossCount: number;
  totalAlloc: number;
  totalPnl: number;
  avgRet: number | null;
  avgRealizedRetNet: number | null;
}

export interface RegimeRowsPage<T> {
  total: number;
  page: number;
  pageSize: number;
  items: T[];
}

export interface RegimeTradeOnBar {
  type: 'entry' | 'exit';
  tsCode: string;
  price: number;
  reason: string;
  pnl?: number;
  tradePhase?: string | null;
}

const num = (v: number | null | undefined): number | null =>
  v === null || v === undefined ? null : v;

export function mapDailyLogEntity(row: RegimeBacktestDailyLogEntity): RegimeBacktestDailyLogDto {
  return {
    tradeDate: row.tradeDate,
    nav: row.nav,
    cash: row.cash,
    regime: row.regime,
    frozenReason: row.frozenReason,
    tradePhase: row.tradePhase,
    entries: (row.entriesJson ?? []) as RegimeDailyAuditEntry[],
    exits: (row.exitsJson ?? []) as RegimeDailyAuditExit[],
    openSymbols: (row.openSymbolsJson ?? []) as string[],
    cooldown: {
      inCooldown: row.inCooldown,
      duration: row.cooldownDuration,
      remaining: row.cooldownRemaining,
      consecLosses: row.consecLosses,
    },
  };
}

export function mapAuditRowToEntity(runId: string, row: RegimeDailyAuditRow): RegimeBacktestDailyLogEntity {
  const ent = new RegimeBacktestDailyLogEntity();
  ent.runId = runId;
  ent.tradeDate = row.tradeDate;
  ent.nav = row.nav;
  ent.cash = row.cash;
  ent.regime = row.regime;
  ent.frozenReason = row.frozenReason;
  ent.tradePhase = row.tradePhase;
  ent.entriesJson = row.entries;
  ent.exitsJson = row.exits;
  ent.openSymbolsJson = row.openSymbols;
  ent.inCooldown = row.cooldown.inCooldown;
  ent.cooldownDuration = row.cooldown.duration;
  ent.cooldownRemaining = row.cooldown.remaining;
  ent.consecLosses = row.cooldown.consecLosses;
  return ent;
}

export function tradeEntityToPosition(t: RegimeBacktestTradeEntity): RegimeBacktestPositionRow {
  return {
    tsCode: t.tsCode,
    signalDate: t.signalDate,
    buyDate: t.buyDate,
    exitDate: t.exitDate,
    regime: t.regime,
    exitMode: t.exitMode,
    tradePhase: t.tradePhase,
    alloc: num(t.alloc),
    ret: num(t.ret),
    realizedRetNet: num(t.realizedRetNet),
    exitReason: t.exitReason,
    costsPaid: num(t.costsPaid),
  };
}

export function aggregateSymbolStats(trades: RegimeBacktestTradeEntity[]): RegimeBacktestSymbolStatRow[] {
  const byCode = new Map<string, RegimeBacktestTradeEntity[]>();
  for (const t of trades) {
    if (t.status !== 'taken') continue;
    const list = byCode.get(t.tsCode) ?? [];
    list.push(t);
    byCode.set(t.tsCode, list);
  }

  const rows: RegimeBacktestSymbolStatRow[] = [];
  for (const [tsCode, list] of byCode) {
    let winCount = 0;
    let lossCount = 0;
    let totalAlloc = 0;
    let totalPnl = 0;
    let retSum = 0;
    let retCount = 0;
    let netSum = 0;
    let netCount = 0;

    for (const t of list) {
      const alloc = num(t.alloc) ?? 0;
      const ret = num(t.ret);
      const net = num(t.realizedRetNet);
      totalAlloc += alloc;
      if (ret !== null) {
        retSum += ret;
        retCount++;
      }
      if (net !== null) {
        netSum += net;
        netCount++;
        totalPnl += alloc * net;
        if (net > 0) winCount++;
        else if (net < 0) lossCount++;
      }
    }

    rows.push({
      tsCode,
      tradeCount: list.length,
      winCount,
      lossCount,
      totalAlloc,
      totalPnl,
      avgRet: retCount > 0 ? retSum / retCount : null,
      avgRealizedRetNet: netCount > 0 ? netSum / netCount : null,
    });
  }

  return rows;
}

const POSITION_SORT_KEYS: Record<string, keyof RegimeBacktestPositionRow> = {
  tsCode: 'tsCode',
  signalDate: 'signalDate',
  buyDate: 'buyDate',
  exitDate: 'exitDate',
  alloc: 'alloc',
  ret: 'ret',
  realizedRetNet: 'realizedRetNet',
};

const SYMBOL_SORT_KEYS: Record<string, keyof RegimeBacktestSymbolStatRow> = {
  tsCode: 'tsCode',
  tradeCount: 'tradeCount',
  winCount: 'winCount',
  totalAlloc: 'totalAlloc',
  totalPnl: 'totalPnl',
  avgRet: 'avgRet',
  avgRealizedRetNet: 'avgRealizedRetNet',
};

function compareValues(a: unknown, b: unknown, asc: boolean): number {
  if (a === b) return 0;
  if (a === null || a === undefined) return 1;
  if (b === null || b === undefined) return -1;
  if (typeof a === 'number' && typeof b === 'number') {
    return asc ? a - b : b - a;
  }
  const sa = String(a);
  const sb = String(b);
  return asc ? sa.localeCompare(sb) : sb.localeCompare(sa);
}

export function paginatePositions(
  rows: RegimeBacktestPositionRow[],
  opts: {
    page: number;
    pageSize: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    tsCode?: string;
  },
): RegimeRowsPage<RegimeBacktestPositionRow> {
  let filtered = rows;
  if (opts.tsCode?.trim()) {
    const q = opts.tsCode.trim();
    filtered = rows.filter((r) => r.tsCode.includes(q));
  }
  const sortKey = POSITION_SORT_KEYS[opts.sortBy ?? 'signalDate'] ?? 'signalDate';
  const asc = (opts.sortOrder ?? 'asc') === 'asc';
  const sorted = [...filtered].sort((a, b) => {
    const cmp = compareValues(a[sortKey], b[sortKey], asc);
    return cmp !== 0 ? cmp : a.tsCode.localeCompare(b.tsCode);
  });
  const page = Math.max(1, opts.page);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize));
  const start = (page - 1) * pageSize;
  return {
    total: sorted.length,
    page,
    pageSize,
    items: sorted.slice(start, start + pageSize),
  };
}

export function paginateSymbolStats(
  rows: RegimeBacktestSymbolStatRow[],
  opts: {
    page: number;
    pageSize: number;
    sortBy?: string;
    sortOrder?: 'asc' | 'desc';
    tsCode?: string;
  },
): RegimeRowsPage<RegimeBacktestSymbolStatRow> {
  let filtered = rows;
  if (opts.tsCode?.trim()) {
    const q = opts.tsCode.trim();
    filtered = rows.filter((r) => r.tsCode.includes(q));
  }
  const sortKey = SYMBOL_SORT_KEYS[opts.sortBy ?? 'totalPnl'] ?? 'totalPnl';
  const asc = (opts.sortOrder ?? 'desc') === 'asc';
  const sorted = [...filtered].sort((a, b) => {
    const cmp = compareValues(a[sortKey], b[sortKey], asc);
    return cmp !== 0 ? cmp : a.tsCode.localeCompare(b.tsCode);
  });
  const page = Math.max(1, opts.page);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize));
  const start = (page - 1) * pageSize;
  return {
    total: sorted.length,
    page,
    pageSize,
    items: sorted.slice(start, start + pageSize),
  };
}

/** Shift YYYYMMDD by N calendar days (approx for window sizing). */
export function shiftTradeDate(date: string, deltaDays: number): string {
  const y = Number(date.slice(0, 4));
  const m = Number(date.slice(4, 6)) - 1;
  const d = Number(date.slice(6, 8));
  const dt = new Date(Date.UTC(y, m, d));
  dt.setUTCDate(dt.getUTCDate() + deltaDays);
  const yy = dt.getUTCFullYear();
  const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(dt.getUTCDate()).padStart(2, '0');
  return `${yy}${mm}${dd}`;
}

export function normalizeTradeDateLabel(date: string): string {
  if (date.length === 8 && /^\d{8}$/.test(date)) {
    return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}`;
  }
  return date;
}

export function overlayTradesOnBars(
  bars: Array<{ open_time: string; close: number; trades?: RegimeTradeOnBar[] }>,
  trades: RegimeBacktestTradeEntity[],
  tsCode: string,
): void {
  const taken = trades.filter((t) => t.status === 'taken' && t.tsCode === tsCode);
  const byDate = new Map(bars.map((b) => [b.open_time, b]));

  for (const t of taken) {
    if (t.buyDate) {
      const bar = byDate.get(normalizeTradeDateLabel(t.buyDate));
      if (bar) {
        bar.trades = bar.trades ?? [];
        bar.trades.push({
          type: 'entry',
          tsCode: t.tsCode,
          price: bar.close,
          reason: t.regime,
          tradePhase: t.tradePhase,
        });
      }
    }
    if (t.exitDate) {
      const bar = byDate.get(normalizeTradeDateLabel(t.exitDate));
      if (bar) {
        bar.trades = bar.trades ?? [];
        const net = num(t.realizedRetNet);
        const alloc = num(t.alloc) ?? 0;
        bar.trades.push({
          type: 'exit',
          tsCode: t.tsCode,
          price: bar.close,
          reason: t.exitReason ?? 'exit',
          pnl: net !== null ? alloc * net : undefined,
          tradePhase: t.tradePhase,
        });
      }
    }
  }
}
