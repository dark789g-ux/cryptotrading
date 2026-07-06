import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { SwIndexDailySyncService } from '../market-data/sw-index-daily/sw-index-daily-sync.service';

const START_DATE = '20250706';
const END_DATE = '20260706';

async function main() {
  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const syncService = app.get(SwIndexDailySyncService);
    console.log(`SW 指数回填：overwrite ${START_DATE}-${END_DATE}`);
    const result = await syncService.sync({
      start_date: START_DATE,
      end_date: END_DATE,
      syncMode: 'overwrite',
    });
    console.log(`完成：success=${result.success}, skipped=${result.skipped}, errors=${result.errors.length}`);
    if (result.errors.length) {
      console.log('错误样本（前 5）：', result.errors.slice(0, 5));
    }
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
