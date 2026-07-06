import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { CustomIndexIndicatorService } from '../market-data/custom-index/compute/custom-index-indicator.service';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const dataSource = app.get(DataSource);
    const service = app.get(CustomIndexIndicatorService);

    const ids = await dataSource.query<{ custom_index_id: string }[]>(`
      SELECT DISTINCT custom_index_id
      FROM custom_index_daily_quotes
      WHERE open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
      ORDER BY custom_index_id
    `);
    console.log(`Custom index OBV backfill: ${ids.length} indices`);

    let total = 0;
    for (const { custom_index_id: id } of ids) {
      const rows = await dataSource.query<{
        tradeDate: string;
        open: number;
        high: number;
        low: number;
        close: number;
        amount: number;
      }[]>(`
        SELECT trade_date AS "tradeDate", open, high, low, close, amount
        FROM custom_index_daily_quotes
        WHERE custom_index_id = $1
          AND open IS NOT NULL AND high IS NOT NULL AND low IS NOT NULL AND close IS NOT NULL
        ORDER BY trade_date ASC
      `, [id]);

      const written = await service.upsertIndicatorsFromQuotes(id, rows);
      total += written;
      console.log(`Custom index ${id}: ${written} rows`);
    }
    console.log(`Custom index OBV backfill done: total=${total} rows`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
