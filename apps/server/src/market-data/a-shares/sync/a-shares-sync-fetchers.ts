import type { Repository } from 'typeorm';
import { AShareAdjFactorEntity } from '../../../entities/a-share/a-share-adj-factor.entity';
import { AShareDailyMetricEntity } from '../../../entities/a-share/a-share-daily-metric.entity';
import { AShareDailyQuoteEntity } from '../../../entities/a-share/a-share-daily-quote.entity';
import { AShareSymbolEntity } from '../../../entities/a-share/a-share-symbol.entity';
import { asNullableString, asString } from '../utils/a-shares-format.util';
import { ADJ_FACTOR_FIELDS, DAILY_BASIC_FIELDS, DAILY_FIELDS, STOCK_BASIC_FIELDS } from './a-shares-sync.constants';
import type { AdjFactorsSyncResult, DailyQuotesSyncResult, LatestAdjFactor } from './a-shares-sync-types';
import { upsertInChunks } from './a-shares-sync-utils';
import type { TushareClientService } from '../services/tushare-client.service';

export interface ASharesSyncFetcherDeps {
  symbolRepo: Repository<AShareSymbolEntity>;
  quoteRepo: Repository<AShareDailyQuoteEntity>;
  metricRepo: Repository<AShareDailyMetricEntity>;
  adjFactorRepo: Repository<AShareAdjFactorEntity>;
  tushareClient: TushareClientService;
}

export async function syncSymbols(deps: ASharesSyncFetcherDeps): Promise<number> {
  const rows = await deps.tushareClient.query('stock_basic', { exchange: '', list_status: 'L' }, STOCK_BASIC_FIELDS);
  const entities = rows.map((row) =>
    deps.symbolRepo.create({
      tsCode: asString(row.ts_code),
      symbol: asString(row.symbol),
      name: asString(row.name),
      area: asNullableString(row.area),
      industry: asNullableString(row.industry),
      market: asNullableString(row.market),
      exchange: asNullableString(row.exchange),
      listStatus: asNullableString(row.list_status),
      listDate: asNullableString(row.list_date),
      delistDate: asNullableString(row.delist_date),
      isHs: asNullableString(row.is_hs),
    }),
  );
  await upsertInChunks(deps.symbolRepo, entities, ['tsCode']);
  return entities.length;
}

export async function syncDailyQuotesByTradeDate(
  deps: ASharesSyncFetcherDeps,
  tradeDate: string,
): Promise<DailyQuotesSyncResult> {
  const rows = await deps.tushareClient.query(
    'daily',
    { trade_date: tradeDate },
    DAILY_FIELDS,
  );
  const entities = rows.map((row) =>
    deps.quoteRepo.create({
      tsCode: asString(row.ts_code),
      tradeDate: asString(row.trade_date),
      open: asNullableString(row.open),
      high: asNullableString(row.high),
      low: asNullableString(row.low),
      close: asNullableString(row.close),
      preClose: asNullableString(row.pre_close),
      change: asNullableString(row.change),
      pctChg: asNullableString(row.pct_chg),
      vol: asNullableString(row.vol),
      amount: asNullableString(row.amount),
    }),
  );
  await upsertInChunks(deps.quoteRepo, entities, ['tsCode', 'tradeDate']);
  return { count: entities.length, tsCodes: rows.map((row) => asString(row.ts_code)).filter(Boolean) };
}

export async function syncDailyMetricsByTradeDate(
  deps: ASharesSyncFetcherDeps,
  tradeDate: string,
): Promise<number> {
  const rows = await deps.tushareClient.query(
    'daily_basic',
    { trade_date: tradeDate },
    DAILY_BASIC_FIELDS,
  );
  const entities = rows.map((row) =>
    deps.metricRepo.create({
      tsCode: asString(row.ts_code),
      tradeDate: asString(row.trade_date),
      turnoverRate: asNullableString(row.turnover_rate),
      volumeRatio: asNullableString(row.volume_ratio),
      pe: asNullableString(row.pe),
      peTtm: asNullableString(row.pe_ttm),
      pb: asNullableString(row.pb),
      totalMv: asNullableString(row.total_mv),
      circMv: asNullableString(row.circ_mv),
    }),
  );
  await upsertInChunks(deps.metricRepo, entities, ['tsCode', 'tradeDate']);
  return entities.length;
}

export async function syncAdjFactorsByTradeDate(
  deps: ASharesSyncFetcherDeps,
  tradeDate: string,
): Promise<AdjFactorsSyncResult> {
  const rows = await deps.tushareClient.query(
    'adj_factor',
    { trade_date: tradeDate },
    ADJ_FACTOR_FIELDS,
  );
  const tsCodes = rows.map((row) => asString(row.ts_code)).filter(Boolean);
  const latestBefore = await loadLatestAdjFactors(deps.adjFactorRepo, tsCodes);
  const entities = rows.map((row) =>
    deps.adjFactorRepo.create({
      tsCode: asString(row.ts_code),
      tradeDate: asString(row.trade_date),
      adjFactor: asNullableString(row.adj_factor),
    }),
  );
  await upsertInChunks(deps.adjFactorRepo, entities, ['tsCode', 'tradeDate']);
  const latestChangedTsCodes = rows
    .filter((row) => isLatestAdjFactorChange(latestBefore.get(asString(row.ts_code)), tradeDate, row.adj_factor))
    .map((row) => asString(row.ts_code))
    .filter(Boolean);
  return { count: entities.length, tsCodes, latestChangedTsCodes };
}

async function loadLatestAdjFactors(
  adjFactorRepo: Repository<AShareAdjFactorEntity>,
  tsCodes: string[],
): Promise<Map<string, LatestAdjFactor>> {
  if (!tsCodes.length) return new Map();
  const rows = await adjFactorRepo.query<Array<{ tsCode: string; tradeDate: string; adjFactor: string | null }>>(`
    SELECT DISTINCT ON (ts_code)
      ts_code AS "tsCode",
      trade_date AS "tradeDate",
      adj_factor AS "adjFactor"
    FROM a_share_adj_factors
    WHERE ts_code = ANY($1::text[])
    ORDER BY ts_code, trade_date DESC
  `, [tsCodes]);
  return new Map(rows.map((row) => [row.tsCode, row]));
}

function isLatestAdjFactorChange(
  latestBefore: LatestAdjFactor | undefined,
  tradeDate: string,
  adjFactor: unknown,
): boolean {
  if (!latestBefore) return true;
  if (tradeDate < latestBefore.tradeDate) return false;
  return String(latestBefore.adjFactor ?? '') !== String(adjFactor ?? '');
}
