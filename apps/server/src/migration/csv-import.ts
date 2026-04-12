#!/usr/bin/env ts-node
/**
 * CSV → PostgreSQL 数据迁移脚本
 *
 * 用法：
 *   npx ts-node -r tsconfig-paths/register src/migration/csv-import.ts \
 *     --dir ../../../../cache --intervals 1h,4h,1d
 *
 * 参数：
 *   --dir       cache 目录路径（默认：../../../../cache）
 *   --intervals 要导入的周期，逗号分隔（默认：1h,4h,1d）
 *   --limit     每个文件最多导入多少行（默认：全部）
 */

import 'reflect-metadata';
import * as path from 'path';
import * as fs from 'fs';
import { parse } from 'csv-parse/sync';
import { DataSource } from 'typeorm';
import { KlineEntity } from '../entities/kline.entity';
import { SymbolEntity } from '../entities/symbol.entity';
import * as dotenv from 'dotenv';

dotenv.config({ path: path.resolve(__dirname, '../../.env') });

const args = process.argv.slice(2);
function getArg(flag: string, def: string): string {
  const idx = args.indexOf(flag);
  return idx >= 0 ? args[idx + 1] : def;
}

const CACHE_DIR = path.resolve(__dirname, getArg('--dir', '../../../../cache'));
const INTERVALS = getArg('--intervals', '1h,4h,1d').split(',');
const ROW_LIMIT = parseInt(getArg('--limit', '0'), 10) || 0;
const BATCH_SIZE = 500;

async function main() {
  const ds = new DataSource({
    type: 'postgres',
    host: process.env.DB_HOST ?? 'localhost',
    port: parseInt(process.env.DB_PORT ?? '5432', 10),
    username: process.env.DB_USER ?? 'cryptouser',
    password: process.env.DB_PASS ?? 'cryptopass',
    database: process.env.DB_NAME ?? 'cryptodb',
    entities: [KlineEntity, SymbolEntity],
    synchronize: true,
    logging: false,
  });

  await ds.initialize();
  console.log('数据库连接成功');

  const klineRepo = ds.getRepository(KlineEntity);
  const symbolRepo = ds.getRepository(SymbolEntity);

  let totalRows = 0;

  for (const interval of INTERVALS) {
    const dir = path.join(CACHE_DIR, `${interval}_klines`);
    if (!fs.existsSync(dir)) {
      console.warn(`目录不存在，跳过: ${dir}`);
      continue;
    }

    const files = fs.readdirSync(dir).filter((f) => f.endsWith(`_${interval}.csv`));
    console.log(`\n[${interval}] 找到 ${files.length} 个文件`);

    for (let fi = 0; fi < files.length; fi++) {
      const file = files[fi];
      const symbol = file.replace(`_${interval}.csv`, '');
      const filePath = path.join(dir, file);

      try {
        const content = fs.readFileSync(filePath, 'utf-8').replace(/^\uFEFF/, ''); // strip BOM
        let records: Record<string, string>[] = parse(content, {
          columns: true,
          skip_empty_lines: true,
          trim: true,
        });

        if (ROW_LIMIT > 0) records = records.slice(-ROW_LIMIT);

        // upsert 交易对
        await symbolRepo.upsert(
          { symbol, baseAsset: symbol.replace('USDT', ''), quoteAsset: 'USDT', isActive: true },
          ['symbol'],
        );

        // 批量 upsert K 线
        for (let i = 0; i < records.length; i += BATCH_SIZE) {
          const batch = records.slice(i, i + BATCH_SIZE);
          const entities: Partial<KlineEntity>[] = batch.map((r) => ({
            symbol,
            interval,
            openTime: new Date(r.open_time.replace(' ', 'T') + 'Z'),
            open: r.open,
            high: r.high,
            low: r.low,
            close: r.close,
            volume: r.volume,
            closeTime: r.close_time ? new Date(r.close_time) : null,
            quoteVolume: r.quote_volume ?? '0',
            trades: r.trades ?? '0',
            takerBuyBaseVol: r.taker_buy_base_vol ?? '0',
            takerBuyQuoteVol: r.taker_buy_quote_vol ?? '0',
            dif: parseFloat(r.DIF) || 0,
            dea: parseFloat(r.DEA) || 0,
            macd: parseFloat(r.MACD) || 0,
            kdjK: parseFloat(r['KDJ.K']) || 50,
            kdjD: parseFloat(r['KDJ.D']) || 50,
            kdjJ: parseFloat(r['KDJ.J']) || 50,
            bbi: parseFloat(r.BBI) || 0,
            ma5: parseFloat(r.MA5) || 0,
            ma30: parseFloat(r.MA30) || 0,
            ma60: parseFloat(r.MA60) || 0,
            ma120: parseFloat(r.MA120) || 0,
            ma240: parseFloat(r.MA240) || 0,
            quoteVolume10: parseFloat(r['10_quote_volume']) || 0,
            atr14: parseFloat(r.atr_14) || 0,
            lossAtr14: parseFloat(r.loss_atr_14) || 0,
            low9: parseFloat(r.low_9) || 0,
            high9: parseFloat(r.high_9) || 0,
            stopLossPct: parseFloat(r.stop_loss_pct) || 0,
            riskRewardRatio: parseFloat(r.risk_reward_ratio) || 0,
          }));

          await klineRepo
            .createQueryBuilder()
            .insert()
            .into(KlineEntity)
            .values(entities as any)
            .orUpdate(
              ['open','high','low','close','volume','dif','dea','macd',
               'kdj_k','kdj_d','kdj_j','bbi','ma5','ma30','ma60','ma120','ma240',
               'quote_volume_10','atr_14','loss_atr_14','low_9','high_9','stop_loss_pct','risk_reward_ratio'],
              ['symbol','interval','open_time'],
            )
            .execute();

          totalRows += batch.length;
        }

        if ((fi + 1) % 50 === 0 || fi === files.length - 1) {
          process.stdout.write(`\r  进度 ${fi + 1}/${files.length} (${symbol})`);
        }
      } catch (err) {
        console.error(`\n  跳过 ${file}: ${(err as Error).message}`);
      }
    }
    console.log();
  }

  await ds.destroy();
  console.log(`\n迁移完成，共导入 ${totalRows} 行 K 线数据`);
}

main().catch((err) => {
  console.error('迁移失败:', err);
  process.exit(1);
});
