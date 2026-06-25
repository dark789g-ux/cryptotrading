import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../app.module';
import { IndexWeightSyncService } from '../market-data/index-weight/index-weight-sync.service';

async function main() {
  const startDate = process.argv[2];
  const endDate = process.argv[3];
  if (!startDate || !endDate) {
    console.error('Usage: ts-node backfill-index-weight.ts <startDate> <endDate>');
    process.exitCode = 1;
    return;
  }

  const app = await NestFactory.createApplicationContext(AppModule);
  try {
    const service = app.get(IndexWeightSyncService);
    const result = await service.syncIfNeeded({ startDate, endDate });
    console.log('Index weight sync result:');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await app.close();
  }
}

void main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.stack ?? err.message : String(err));
  process.exitCode = 1;
});
