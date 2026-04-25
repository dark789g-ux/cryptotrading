import type { PositionQueryOptions, StatsRow, SymbolQueryOptions } from '../backtest.types';

function asNumber(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string' && value.trim() !== '') {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function matchesNumberRange(value: unknown, min?: number, max?: number): boolean {
  const num = asNumber(value);
  if (num === null) return min === undefined && max === undefined;
  if (min !== undefined && num < min) return false;
  if (max !== undefined && num > max) return false;
  return true;
}

function matchesTimeRange(value: unknown, start?: string, end?: string): boolean {
  const time = asString(value);
  if (!start && !end) return true;
  if (!time) return false;
  if (start && time < start) return false;
  if (end && time > end) return false;
  return true;
}

function sortReportRows(
  rows: StatsRow[],
  sortBy: string,
  sortOrder: 'ASC' | 'DESC',
): void {
  const dir = sortOrder === 'ASC' ? 1 : -1;
  rows.sort((a, b) => {
    const av = a[sortBy] ?? 0;
    const bv = b[sortBy] ?? 0;
    if (typeof av === 'string' && typeof bv === 'string') {
      return av.localeCompare(bv) * dir;
    }
    return ((av as number) - (bv as number)) * dir;
  });
}

export function filterSortPaginatePositions(
  reportData: Record<string, unknown>,
  opts: PositionQueryOptions,
): { rows: StatsRow[]; total: number; page: number; pageSize: number } {
  let rows = [...((reportData.positions ?? []) as StatsRow[])];

  if (opts.symbol?.trim()) {
    rows = rows.filter((row) => asString(row.symbol) === opts.symbol!.trim());
  }
  if (opts.stopType?.trim()) {
    rows = rows.filter(
      (row) =>
        Array.isArray(row.stopTypes) &&
        row.stopTypes.some((item) => asString(item) === opts.stopType!.trim()),
    );
  }

  rows = rows.filter(
    (row) =>
      matchesNumberRange(row.pnl, opts.pnlMin, opts.pnlMax) &&
      matchesNumberRange(row.returnPct, opts.returnPctMin, opts.returnPctMax) &&
      matchesTimeRange(row.entryTime, opts.entryStart, opts.entryEnd) &&
      matchesTimeRange(row.closeTime, opts.closeStart, opts.closeEnd),
  );

  const ALLOWED = ['entryTime', 'entryPrice', 'closeTime', 'sellPrice', 'pnl', 'returnPct', 'holdCandles', 'overallReturnPct', 'cumulativeWinRate', 'cumulativeOdds', 'windowWinRate', 'windowOdds'];
  const sortBy = ALLOWED.includes(opts.sortBy ?? '') ? opts.sortBy! : 'entryTime';
  sortReportRows(rows, sortBy, opts.sortOrder);

  const total = rows.length;
  const start = (opts.page - 1) * opts.pageSize;
  return {
    rows: rows.slice(start, start + opts.pageSize),
    total,
    page: opts.page,
    pageSize: opts.pageSize,
  };
}

export function filterSortPaginateSymbols(
  reportData: Record<string, unknown>,
  opts: SymbolQueryOptions,
): { rows: StatsRow[]; total: number; page: number; pageSize: number } {
  let rows = [...((reportData.symbols ?? []) as StatsRow[])];

  if (opts.symbol?.trim()) {
    rows = rows.filter((row) => asString(row.symbol) === opts.symbol!.trim());
  }

  rows = rows.filter(
    (row) =>
      matchesNumberRange(row.totalPnl, opts.totalPnlMin, opts.totalPnlMax) &&
      matchesNumberRange(row.winRate, opts.winRateMin, opts.winRateMax),
  );

  const ALLOWED = ['posCount', 'winRate', 'totalPnl', 'avgReturn', 'bestReturn', 'worstReturn', 'avgHold'];
  const sortBy = ALLOWED.includes(opts.sortBy ?? '') ? opts.sortBy! : 'totalPnl';
  sortReportRows(rows, sortBy, opts.sortOrder);

  const total = rows.length;
  const start = (opts.page - 1) * opts.pageSize;
  return {
    rows: rows.slice(start, start + opts.pageSize),
    total,
    page: opts.page,
    pageSize: opts.pageSize,
  };
}
