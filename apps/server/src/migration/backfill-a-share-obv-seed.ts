import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { DataSource } from 'typeorm';
import { AppModule } from '../app.module';
import { ASharesIndicatorService } from '../market-data/a-shares/services/a-shares-indicator.service';

const BATCH = 100;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const dataSource = app.get(DataSource);
    const indicatorService = app.get(ASharesIndicatorService);

    const needRepair = await dataSource.query<{ ts_code: string }[]>(`
      SELECT DISTINCT ts_code FROM raw.indicator_calc_state
      WHERE NOT state ? 'signedAmounts' OR jsonb_array_length(state->'signedAmounts') = 0
      ORDER BY ts_code
    `);
    const tsCodes = needRepair.map((r) => r.ts_code);
    console.log(`\u9700\u4fee\u590d seed \u7684\u80a1\u7968\uff1a${tsCodes.length} \u53ea`);

    for (const tsCode of tsCodes) {
      await dataSource.query(`
        UPDATE a_share_sync_states
        SET indicator_dirty_from_date = indicator_calculated_to_date
        WHERE ts_code = $1 AND indicator_dirty_from_date IS NULL
      `, [tsCode]);
    }

    let total = 0;
    for (let i = 0; i < tsCodes.length; i += BATCH) {
      const batch = tsCodes.slice(i, i + BATCH);
      const written = await indicatorService.recalculateDirtyIndicatorsForSymbols(batch);
      total += written;
      console.log(`batch ${i / BATCH + 1}/${Math.ceil(tsCodes.length / BATCH)}\uff1a${batch.length} \u53ea\uff0c${written} \u884c`);
    }
    console.log(`\u5b8c\u6210\uff1a\u91cd\u7b97 ${total} \u884c`);
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
