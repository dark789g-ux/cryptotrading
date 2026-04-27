import type { Repository } from 'typeorm';
import { asString, formatChinaDate } from '../utils/a-shares-format.util';
import type { ASharesSyncFailedItem, ASharesSyncRange, ASharesSyncResult, ASharesSyncStatus, SyncASharesDto } from '../a-shares.types';
import type { ASharesSyncMode } from './a-shares-sync-types';
import type { TushareClientService } from '../services/tushare-client.service';

export function normalizeSyncMode(value: string | undefined): ASharesSyncMode {
  return value === 'overwrite' ? 'overwrite' : 'incremental';
}

export async function resolveOpenTradeDates(
  tushareClient: TushareClientService,
  range: ASharesSyncRange,
): Promise<string[]> {
  const rows = await tushareClient.query(
    'trade_cal',
    { exchange: 'SSE', start_date: range.startDate, end_date: range.endDate, is_open: 1 },
    'cal_date,is_open',
  );
  return rows
    .map((row) => asString(row.cal_date))
    .filter((date) => date.length === 8)
    .sort();
}

export function calculateSyncPercent(current: number, total: number): number {
  if (total <= 0) return 100;
  return Math.round((10 + (current / total) * 90) * 10) / 10;
}

export function createFailedItem(apiName: string, tradeDate: string, err: unknown): ASharesSyncFailedItem {
  return {
    tradeDate,
    apiName,
    message: err instanceof Error ? err.message : String(err),
  };
}

export function createResult(
  status: ASharesSyncStatus,
  symbols: number,
  quotes: number,
  metrics: number,
  adjFactors: number,
  indicators: number,
  failedItems: ASharesSyncFailedItem[],
  range: ASharesSyncRange,
  skippedDates: number,
  skippedDatasets: number,
): ASharesSyncResult {
  return {
    ok: status !== 'error',
    status,
    symbols,
    quotes,
    metrics,
    adjFactors,
    indicators,
    failedCount: failedItems.length,
    failedItems,
    startDate: range.startDate,
    endDate: range.endDate,
    skippedDates,
    skippedDatasets,
  };
}

export async function resolveSyncRange(
  tushareClient: TushareClientService,
  dto: SyncASharesDto,
): Promise<ASharesSyncRange> {
  if (dto.tradeDate) return { startDate: dto.tradeDate, endDate: dto.tradeDate };
  if (dto.startDate && dto.endDate) return { startDate: dto.startDate, endDate: dto.endDate };

  const endDate = formatChinaDate(new Date());
  const start = new Date();
  start.setUTCDate(start.getUTCDate() - 14);
  const startDate = formatChinaDate(start);
  const rows = await tushareClient.query(
    'trade_cal',
    { exchange: 'SSE', start_date: startDate, end_date: endDate, is_open: 1 },
    'cal_date,is_open',
  );
  const openDates = rows
    .map((row) => asString(row.cal_date))
    .filter((date) => date.length === 8)
    .sort();
  const latest = openDates.length ? openDates[openDates.length - 1] : undefined;
  const tradeDate = latest ?? endDate;
  return { startDate: tradeDate, endDate: tradeDate };
}

export async function upsertInChunks<Entity extends object>(
  repo: Repository<Entity>,
  entities: Entity[],
  conflictPaths: string[],
): Promise<void> {
  const chunkSize = 1000;
  for (let index = 0; index < entities.length; index += chunkSize) {
    await repo.upsert(entities.slice(index, index + chunkSize), conflictPaths);
  }
}
