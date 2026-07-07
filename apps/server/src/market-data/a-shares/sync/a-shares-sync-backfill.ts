import type { TushareRow } from '../services/tushare-client.service';
import type { TushareClientService } from '../services/tushare-client.service';

export interface BackfillResult {
  rows: TushareRow[];
  partial: boolean;
  backfilled: number;
}

const BACKFILL_BATCH_SIZE = 100;

export async function queryWithBackfill(
  tushareClient: TushareClientService,
  apiName: string,
  tradeDate: string,
  fields: string,
  expectedTsCodes: string[],
  threshold: number,
): Promise<BackfillResult> {
  const initialRows = await tushareClient.query(apiName, { trade_date: tradeDate }, fields);
  const allRows = [...initialRows];
  const returnedSet = new Set(
    initialRows.map((row) => String(row.ts_code)).filter(Boolean),
  );
  const missing = expectedTsCodes.filter((code) => !returnedSet.has(code));
  const ratio = expectedTsCodes.length > 0 ? missing.length / expectedTsCodes.length : 0;
  const partial = ratio > threshold;

  if (!partial || missing.length === 0) {
    return { rows: allRows, partial: false, backfilled: 0 };
  }

  let backfilled = 0;
  for (let i = 0; i < missing.length; i += BACKFILL_BATCH_SIZE) {
    const batch = missing.slice(i, i + BACKFILL_BATCH_SIZE);
    const batchRows = await tushareClient.query(
      apiName,
      { ts_code: batch.join(','), trade_date: tradeDate },
      fields,
    );
    allRows.push(...batchRows);
    backfilled += batchRows.length;
  }
  return { rows: allRows, partial: true, backfilled };
}
