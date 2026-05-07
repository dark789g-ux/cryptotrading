// apps/server/src/market-data/money-flow/money-flow-sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { SyncFlowDto } from './dto/sync-flow.dto';

// moneyflow_ths: https://tushare.pro/wctapi/documents/348.md
const STOCK_FIELDS = 'trade_date,ts_code,name,pct_change,latest,net_amount,net_d5_amount,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate';
// moneyflow_ind_ths: https://tushare.pro/document/2?doc_id=343
const INDUSTRY_FIELDS = 'trade_date,ts_code,industry,pct_change,net_buy_amount,net_sell_amount,net_amount';
// moneyflow_cnt_ths: https://tushare.pro/document/2?doc_id=371
const SECTOR_FIELDS = 'trade_date,ts_code,name,pct_change,net_buy_amount,net_sell_amount,net_amount';
// moneyflow_mkt_dc: https://tushare.pro/wctapi/documents/345.md
const MARKET_FIELDS = 'trade_date,net_amount,buy_lg_amount,buy_sm_amount';

export interface MoneyFlowSyncResult {
  success: number;
  skipped: number;
  errors: string[];
}

function asNullableNumeric(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  return String(v);
}

function asString(v: unknown): string {
  return v == null ? '' : String(v);
}

/**
 * 按一组字段对实体数组去重，保留每组最后一条，防止 ON CONFLICT DO UPDATE 同批次重复键报错。
 */
function deduplicateBy<T extends object>(entities: T[], keys: (keyof T)[]): T[] {
  const map = new Map<string, T>();
  for (const entity of entities) {
    const conflictKey = keys.map((k) => String(entity[k])).join('|');
    map.set(conflictKey, entity);
  }
  return Array.from(map.values());
}

@Injectable()
export class MoneyFlowSyncService {
  private readonly logger = new Logger(MoneyFlowSyncService.name);

  constructor(
    @InjectRepository(MoneyFlowStockEntity)
    private readonly stockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(MoneyFlowIndustryEntity)
    private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
    @InjectRepository(MoneyFlowSectorEntity)
    private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
    @InjectRepository(MoneyFlowMarketEntity)
    private readonly marketRepo: Repository<MoneyFlowMarketEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  async syncStocks(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    let success = 0;
    const rows = await this.tushareClient.query(
      'moneyflow_ths',
      { start_date: dto.start_date, end_date: dto.end_date },
      STOCK_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_ths 返回空数据', { start_date: dto.start_date, end_date: dto.end_date });
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.stockRepo.create({
        tsCode: asString(row.ts_code),
        tradeDate: asString(row.trade_date),
        name: asNullableNumeric(row.name),
        pctChange: asNullableNumeric(row.pct_change),
        latest: asNullableNumeric(row.latest),
        netAmount: asNullableNumeric(row.net_amount),
        netD5Amount: asNullableNumeric(row.net_d5_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buyLgAmountRate: asNullableNumeric(row.buy_lg_amount_rate),
        buyMdAmount: asNullableNumeric(row.buy_md_amount),
        buyMdAmountRate: asNullableNumeric(row.buy_md_amount_rate),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
        buySmAmountRate: asNullableNumeric(row.buy_sm_amount_rate),
      }),
    );

    const deduped = deduplicateBy(entities, ['tsCode', 'tradeDate']);
    const chunkSize = 1000;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      await this.stockRepo.upsert(deduped.slice(i, i + chunkSize), ['tsCode', 'tradeDate']);
    }
    success = deduped.length;
    return { success, skipped: 0, errors };
  }

  async syncIndustries(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const rows = await this.tushareClient.query(
      'moneyflow_ind_ths',
      { start_date: dto.start_date, end_date: dto.end_date },
      INDUSTRY_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_ind_ths 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.industryRepo.create({
        tradeDate: asString(row.trade_date),
        tsCode: asString(row.ts_code),
        industry: asString(row.industry),
        pctChange: asNullableNumeric(row.pct_change),
        netBuyAmount: asNullableNumeric(row.net_buy_amount),
        netSellAmount: asNullableNumeric(row.net_sell_amount),
        netAmount: asNullableNumeric(row.net_amount),
      }),
    );

    const deduped = deduplicateBy(entities, ['tsCode', 'tradeDate']);
    const chunkSize = 1000;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      await this.industryRepo.upsert(deduped.slice(i, i + chunkSize), ['tsCode', 'tradeDate']);
    }
    return { success: deduped.length, skipped: 0, errors };
  }

  async syncSectors(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const rows = await this.tushareClient.query(
      'moneyflow_cnt_ths',
      { start_date: dto.start_date, end_date: dto.end_date },
      SECTOR_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_cnt_ths 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.sectorRepo.create({
        tradeDate: asString(row.trade_date),
        tsCode: asString(row.ts_code),
        sector: asString(row.name),
        pctChange: asNullableNumeric(row.pct_change),
        netBuyAmount: asNullableNumeric(row.net_buy_amount),
        netSellAmount: asNullableNumeric(row.net_sell_amount),
        netAmount: asNullableNumeric(row.net_amount),
      }),
    );

    const deduped = deduplicateBy(entities, ['tsCode', 'tradeDate']);
    const chunkSize = 1000;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      await this.sectorRepo.upsert(deduped.slice(i, i + chunkSize), ['tsCode', 'tradeDate']);
    }
    return { success: deduped.length, skipped: 0, errors };
  }

  async syncMarket(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const rows = await this.tushareClient.query(
      'moneyflow_mkt_dc',
      { start_date: dto.start_date, end_date: dto.end_date },
      MARKET_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_mkt_dc 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.marketRepo.create({
        tradeDate: asString(row.trade_date),
        netAmount: asNullableNumeric(row.net_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
      }),
    );

    const deduped = deduplicateBy(entities, ['tradeDate']);
    if (deduped.length < entities.length) {
      this.logger.warn(
        `moneyflow_dc 返回重复 trade_date，原始 ${entities.length} 条，去重后 ${deduped.length} 条。`,
        dto,
      );
    }
    const chunkSize = 1000;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      await this.marketRepo.upsert(deduped.slice(i, i + chunkSize), ['tradeDate']);
    }
    return { success: deduped.length, skipped: 0, errors };
  }
}
