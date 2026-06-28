import type { DataSource } from 'typeorm';

import { allMemberCodes } from './custom-index-weight-resolver';
import type {
  ComponentBar,
  ComputeContext,
  StockMeta,
  WeightVersion,
} from './custom-index-compute.types';

interface TradeCalRow {
  cal_date: string;
}

interface StockMetaRow {
  ts_code: string;
  list_date: string | null;
  delist_date: string | null;
}

interface AdjLatestRow {
  ts_code: string;
  adj_factor: string | number | null;
}

interface DailyQuoteRow {
  ts_code: string;
  trade_date: string;
  open: string | number | null;
  high: string | number | null;
  low: string | number | null;
  close: string | number | null;
  pre_close: string | number | null;
  vol: string | number | null;
  amount: string | number | null;
  qfq_open: string | number | null;
  qfq_high: string | number | null;
  qfq_low: string | number | null;
  qfq_close: string | number | null;
}

interface AdjSeriesRow {
  ts_code: string;
  trade_date: string;
  adj_factor: string | number | null;
}

function parseFloatOrNull(value: unknown): number | null {
  if (value === null || value === undefined) {
    return null;
  }
  const x = Number(value);
  return Number.isFinite(x) ? x : null;
}

function pickQfq(
  row: DailyQuoteRow,
  qfqField: keyof DailyQuoteRow,
  rawField: keyof DailyQuoteRow,
  adj: number | null,
  adjLatest: number | null,
): number | null {
  const qfq = parseFloatOrNull(row[qfqField]);
  if (qfq !== null) {
    return qfq;
  }
  const raw = parseFloatOrNull(row[rawField]);
  if (raw === null) {
    return null;
  }
  if (adj !== null && adjLatest !== null && adjLatest > 0) {
    return raw * adj / adjLatest;
  }
  return raw;
}

async function loadTradeDates(
  dataSource: DataSource,
  startDate: string,
): Promise<string[]> {
  const rows = (await dataSource.query(
    `
      SELECT cal_date
      FROM raw.trade_cal
      WHERE exchange = 'SSE'
        AND is_open = '1'
        AND cal_date >= $1
      ORDER BY cal_date ASC
    `,
    [startDate],
  )) as TradeCalRow[];

  return rows.map((row) => String(row.cal_date));
}

async function loadStockMeta(
  dataSource: DataSource,
  codes: Set<string>,
): Promise<Record<string, StockMeta>> {
  if (codes.size === 0) {
    return {};
  }

  const rows = (await dataSource.query(
    `
      SELECT ts_code, list_date, delist_date
      FROM a_share_symbols
      WHERE ts_code = ANY($1::text[])
    `,
    [Array.from(codes)],
  )) as StockMetaRow[];

  const out: Record<string, StockMeta> = {};
  for (const row of rows) {
    out[String(row.ts_code)] = {
      listDate: row.list_date ? String(row.list_date) : null,
      delistDate: row.delist_date ? String(row.delist_date) : null,
    };
  }
  return out;
}

async function loadAdjLatest(
  dataSource: DataSource,
  codes: Set<string>,
): Promise<Record<string, number>> {
  if (codes.size === 0) {
    return {};
  }

  const rows = (await dataSource.query(
    `
      SELECT DISTINCT ON (ts_code) ts_code, adj_factor
      FROM raw.adj_factor
      WHERE ts_code = ANY($1::text[])
      ORDER BY ts_code, trade_date DESC
    `,
    [Array.from(codes)],
  )) as AdjLatestRow[];

  const out: Record<string, number> = {};
  for (const row of rows) {
    const adj = parseFloatOrNull(row.adj_factor);
    if (adj !== null) {
      out[String(row.ts_code)] = adj;
    }
  }
  return out;
}

async function loadDailyQuotes(
  dataSource: DataSource,
  codes: Set<string>,
  startDate: string,
): Promise<DailyQuoteRow[]> {
  if (codes.size === 0) {
    return [];
  }

  return (await dataSource.query(
    `
      SELECT ts_code, trade_date,
             open, high, low, close, pre_close, vol, amount,
             qfq_open, qfq_high, qfq_low, qfq_close
      FROM raw.daily_quote
      WHERE ts_code = ANY($1::text[])
        AND trade_date >= $2
      ORDER BY trade_date ASC, ts_code ASC
    `,
    [Array.from(codes), startDate],
  )) as DailyQuoteRow[];
}

async function loadAdjSeries(
  dataSource: DataSource,
  codes: Set<string>,
  startDate: string,
): Promise<Map<string, number>> {
  if (codes.size === 0) {
    return new Map();
  }

  const rows = (await dataSource.query(
    `
      SELECT ts_code, trade_date, adj_factor
      FROM raw.adj_factor
      WHERE ts_code = ANY($1::text[])
        AND trade_date >= $2
      ORDER BY trade_date ASC
    `,
    [Array.from(codes), startDate],
  )) as AdjSeriesRow[];

  const out = new Map<string, number>();
  for (const row of rows) {
    const adj = parseFloatOrNull(row.adj_factor);
    if (adj !== null) {
      out.set(`${String(row.ts_code)}|${String(row.trade_date)}`, adj);
    }
  }
  return out;
}

/** 只读加载成分行情上下文（port compute.py _load_compute_context）。 */
export async function loadComputeContext(
  dataSource: DataSource,
  versions: readonly WeightVersion[],
  baseDate: string,
): Promise<ComputeContext> {
  const codes = allMemberCodes(versions);
  const [tradeDates, stockMeta, adjLatest, quoteRows, adjSeries] =
    await Promise.all([
      loadTradeDates(dataSource, baseDate),
      loadStockMeta(dataSource, codes),
      loadAdjLatest(dataSource, codes),
      loadDailyQuotes(dataSource, codes, baseDate),
      loadAdjSeries(dataSource, codes, baseDate),
    ]);

  const prevPrice = new Map<string, number>();
  const prevRawClose = new Map<string, number>();
  const prevAdj = new Map<string, number>();
  const barsByDate: Record<string, Record<string, ComponentBar>> = {};

  for (const row of quoteRows) {
    const code = String(row.ts_code);
    const tradeDate = String(row.trade_date);
    const adj = adjSeries.get(`${code}|${tradeDate}`) ?? null;
    const adjLat = adjLatest[code] ?? null;

    const closeRaw = parseFloatOrNull(row.close);
    const price = pickQfq(row, 'qfq_close', 'close', adj, adjLat);
    const openP = pickQfq(row, 'qfq_open', 'open', adj, adjLat);
    const highP = pickQfq(row, 'qfq_high', 'high', adj, adjLat);
    const lowP = pickQfq(row, 'qfq_low', 'low', adj, adjLat);
    if (price === null || openP === null || highP === null || lowP === null) {
      continue;
    }

    const bar: ComponentBar = {
      conCode: code,
      tradeDate,
      open: parseFloatOrNull(row.open) ?? closeRaw ?? price,
      high: parseFloatOrNull(row.high) ?? price,
      low: parseFloatOrNull(row.low) ?? price,
      close: closeRaw ?? price,
      preClose: parseFloatOrNull(row.pre_close),
      vol: parseFloatOrNull(row.vol),
      amount: parseFloatOrNull(row.amount),
      price,
      pricePrev: prevPrice.get(code) ?? null,
      pricePrevRaw: prevRawClose.get(code) ?? null,
      openPrice: openP,
      highPrice: highP,
      lowPrice: lowP,
      adjFactor: adj,
      adjFactorPrev: prevAdj.get(code) ?? null,
    };

    if (!barsByDate[tradeDate]) {
      barsByDate[tradeDate] = {};
    }
    barsByDate[tradeDate][code] = bar;
    prevPrice.set(code, price);
    if (closeRaw !== null) {
      prevRawClose.set(code, closeRaw);
    }
    if (adj !== null) {
      prevAdj.set(code, adj);
    }
  }

  return {
    tradeDates,
    barsByDate,
    stockMeta,
    adjLatest,
    warnings: [],
  };
}
