import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { EtfIndicatorService } from '../market-data/etf/etf-indicator.service';

const BATCH_SIZE = 50;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const dataSource = app.get(DataSource);
    const service = app.get(EtfIndicatorService);

    const rows = await dataSource.query<{ ts_code: string }[]>(`
      SELECT DISTINCT ts_code
      FROM raw.fund_daily
      WHERE open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
      ORDER BY ts_code
    `);
    const codes = rows.map((r) => r.ts_code);
    console.log(`ETF OBV backfill: ${codes.length} codes`);

    let total = 0;
    for (let i = 0; i < codes.length; i += BATCH_SIZE) {
      const batch = codes.slice(i, i + BATCH_SIZE);
      const result = await service.recalculateIndicators(batch);
      total += result.success;
      console.log(`ETF OBV batch ${i / BATCH_SIZE + 1}/${Math.ceil(codes.length / BATCH_SIZE)}: ${batch.length} codes, ${result.success} rows`);
    }
    console.log(`ETF OBV backfill done: total=${total} rows`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
