import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { EtfFundDailyService } from '../market-data/etf/etf-fund-daily.service';
import { EtfIndicatorService } from '../market-data/etf/etf-indicator.service';

const START_DATE = '20250706';
const END_DATE = '20260706';
const INDICATOR_BATCH = 50;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const dataSource = app.get(DataSource);
    const fundDailyService = app.get(EtfFundDailyService);
    const indicatorService = app.get(EtfIndicatorService);

    const rows = await dataSource.query<{ ts_code: string }[]>(
      `SELECT ts_code FROM raw.etf_symbol WHERE tracked = true ORDER BY ts_code`,
    );
    const etfCodes = rows.map((r) => r.ts_code);
    console.log(`ETF fund_daily history backfill: ${etfCodes.length} codes, ${START_DATE}-${END_DATE}`);

    console.log('Phase 1: syncFundDaily ...');
    const syncResult = await fundDailyService.syncFundDaily(etfCodes, START_DATE, END_DATE);
    console.log(`Phase 1 done: ${syncResult.success} rows, ${syncResult.errors.length} errors`);
    if (syncResult.errors.length > 0) {
      for (const e of syncResult.errors) {
        console.error(`  [sync error] ${e.apiName}: ${e.message}`);
      }
    }

    console.log('Phase 2: recalculateIndicators ...');
    let total = 0;
    for (let i = 0; i < etfCodes.length; i += INDICATOR_BATCH) {
      const batch = etfCodes.slice(i, i + INDICATOR_BATCH);
      const result = await indicatorService.recalculateIndicators(batch);
      total += result.success;
      console.log(`Phase 2 batch ${i / INDICATOR_BATCH + 1}/${Math.ceil(etfCodes.length / INDICATOR_BATCH)}: ${result.success} rows`);
    }
    console.log(`Phase 2 done: ${total} indicator rows`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
