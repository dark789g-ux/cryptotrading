import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { DataSource } from 'typeorm';
import { ASharesIndicatorService } from '../market-data/a-shares/services/a-shares-indicator.service';

const PROGRESS_INTERVAL = 10;

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  const indicatorService = app.get(ASharesIndicatorService);
  const dataSource = app.get(DataSource);

  try {
    const affectedRows = await dataSource.query<Array<{ tsCode: string }>>(`
      SELECT ts_code AS "tsCode" FROM raw.adj_factor
      GROUP BY ts_code HAVING MIN(adj_factor) <> MAX(adj_factor)
      ORDER BY ts_code
    `);
    const tsCodes = affectedRows.map((r) => r.tsCode);
    console.log(`需要重算的股票数: ${tsCodes.length}`);

    const startTime = Date.now();
    let successCount = 0;
    const failures: Array<{ tsCode: string; error: string }> = [];

    for (let i = 0; i < tsCodes.length; i++) {
      const tsCode = tsCodes[i];
      try {
        await indicatorService.recalculateIndicatorsForSymbols([tsCode]);
        successCount++;
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`[失败] ${tsCode}: ${msg}`);
        failures.push({ tsCode, error: msg });
      }
      if ((i + 1) % PROGRESS_INTERVAL === 0 || i === tsCodes.length - 1) {
        const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
        console.log(`[${i + 1}/${tsCodes.length}] 已处理，耗时 ${elapsed}s`);
      }
    }

    const totalSec = ((Date.now() - startTime) / 1000).toFixed(1);
    console.log(`\n完成: 总数=${tsCodes.length}, 成功=${successCount}, 失败=${failures.length}, 耗时=${totalSec}s`);
    if (failures.length > 0) {
      console.error('\n失败列表:');
      for (const f of failures) {
        console.error(`  ${f.tsCode}: ${f.error}`);
      }
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
