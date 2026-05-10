// apps/server/src/market-data/money-flow/money-flow-sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { resolveOpenTradeDates } from '../a-shares/sync/a-shares-sync-utils';
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

function asNullableNumeric(v: unknown, divisor?: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  const n = Number(v);
  if (isNaN(n)) return null;
  return String(divisor ? n / divisor : n);
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

  private async getTradeDates(dto: SyncFlowDto): Promise<string[]> {
    return resolveOpenTradeDates(this.tushareClient, {
      startDate: dto.start_date,
      endDate: dto.end_date,
    });
  }

  /** 增量模式：从交易日列表中过滤掉指定 repo 中已有数据的日期 */
  private async filterExistingDates<T extends { tradeDate: string }>(
    repo: Repository<T>,
    tradeDates: string[],
  ): Promise<{ dates: string[]; skipped: number }> {
    const existing = await repo
      .createQueryBuilder('e')
      .select('DISTINCT e.trade_date', 'tradeDate')
      .where('e.trade_date IN (:...dates)', { dates: tradeDates })
      .getRawMany<{ tradeDate: string }>();
    const existingSet = new Set(existing.map((r) => r.tradeDate));
    const dates = tradeDates.filter((d) => !existingSet.has(d));
    return { dates, skipped: tradeDates.length - dates.length };
  }

  private async batchUpsert<T extends object>(
    repo: Repository<T>,
    entities: T[],
    conflictKeys: (keyof T)[],
  ): Promise<number> {
    const deduped = deduplicateBy(entities, conflictKeys);
    const chunkSize = 1000;
    for (let i = 0; i < deduped.length; i += chunkSize) {
      await repo.upsert(deduped.slice(i, i + chunkSize) as any, conflictKeys as string[]);
    }
    return deduped.length;
  }

  async syncStocks(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const allTradeDates = await this.getTradeDates(dto)
      .catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!allTradeDates.length) {
      this.logger.warn('未获取到交易日', dto);
      return { success: 0, skipped: 0, errors };
    }

    let tradeDates = allTradeDates;
    let skipped = 0;
    if (dto.syncMode !== 'overwrite') {
      const filtered = await this.filterExistingDates(this.stockRepo, allTradeDates);
      tradeDates = filtered.dates;
      skipped = filtered.skipped;
      if (!tradeDates.length) return { success: 0, skipped, errors };
    }

    const allEntities: MoneyFlowStockEntity[] = [];

    for (const date of tradeDates) {
      const rows = await this.tushareClient.query(
        'moneyflow_ths',
        { start_date: date, end_date: date },
        STOCK_FIELDS,
      ).catch((e: unknown) => { errors.push(`[${date}] ${String(e)}`); return []; });

      if (rows.length >= 6000) {
        this.logger.warn(`moneyflow_ths ${date} 返回 ${rows.length} 条，可能截断`);
      }

      for (const row of rows) {
        allEntities.push(this.stockRepo.create({
          tsCode: asString(row.ts_code),
          tradeDate: asString(row.trade_date),
          name: asString(row.name),
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
        }));
      }
    }

    const success = await this.batchUpsert(this.stockRepo, allEntities, ['tsCode', 'tradeDate']);
    return { success, skipped, errors };
  }

  async syncIndustries(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const allTradeDates = await this.getTradeDates(dto)
      .catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!allTradeDates.length) {
      this.logger.warn('未获取到交易日', dto);
      return { success: 0, skipped: 0, errors };
    }

    let tradeDates = allTradeDates;
    let skipped = 0;
    if (dto.syncMode !== 'overwrite') {
      const filtered = await this.filterExistingDates(this.industryRepo, allTradeDates);
      tradeDates = filtered.dates;
      skipped = filtered.skipped;
      if (!tradeDates.length) return { success: 0, skipped, errors };
    }

    const allEntities: MoneyFlowIndustryEntity[] = [];

    for (const date of tradeDates) {
      const rows = await this.tushareClient.query(
        'moneyflow_ind_ths',
        { start_date: date, end_date: date },
        INDUSTRY_FIELDS,
      ).catch((e: unknown) => { errors.push(`[${date}] ${String(e)}`); return []; });

      if (rows.length >= 6000) {
        this.logger.warn(`moneyflow_ind_ths ${date} 返回 ${rows.length} 条，可能截断`);
      }

      for (const row of rows) {
        allEntities.push(this.industryRepo.create({
          tradeDate: asString(row.trade_date),
          tsCode: asString(row.ts_code),
          industry: asString(row.industry),
          pctChange: asNullableNumeric(row.pct_change),
          netBuyAmount: asNullableNumeric(row.net_buy_amount),
          netSellAmount: asNullableNumeric(row.net_sell_amount),
          netAmount: asNullableNumeric(row.net_amount),
        }));
      }
    }

    const success = await this.batchUpsert(this.industryRepo, allEntities, ['tsCode', 'tradeDate']);
    return { success, skipped, errors };
  }

  async syncSectors(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const allTradeDates = await this.getTradeDates(dto)
      .catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!allTradeDates.length) {
      this.logger.warn('未获取到交易日', dto);
      return { success: 0, skipped: 0, errors };
    }

    let tradeDates = allTradeDates;
    let skipped = 0;
    if (dto.syncMode !== 'overwrite') {
      const filtered = await this.filterExistingDates(this.sectorRepo, allTradeDates);
      tradeDates = filtered.dates;
      skipped = filtered.skipped;
      if (!tradeDates.length) return { success: 0, skipped, errors };
    }

    const allEntities: MoneyFlowSectorEntity[] = [];

    for (const date of tradeDates) {
      const rows = await this.tushareClient.query(
        'moneyflow_cnt_ths',
        { start_date: date, end_date: date },
        SECTOR_FIELDS,
      ).catch((e: unknown) => { errors.push(`[${date}] ${String(e)}`); return []; });

      if (rows.length >= 6000) {
        this.logger.warn(`moneyflow_cnt_ths ${date} 返回 ${rows.length} 条，可能截断`);
      }

      for (const row of rows) {
        allEntities.push(this.sectorRepo.create({
          tradeDate: asString(row.trade_date),
          tsCode: asString(row.ts_code),
          sector: asString(row.name),
          pctChange: asNullableNumeric(row.pct_change),
          netBuyAmount: asNullableNumeric(row.net_buy_amount),
          netSellAmount: asNullableNumeric(row.net_sell_amount),
          netAmount: asNullableNumeric(row.net_amount),
        }));
      }
    }

    const success = await this.batchUpsert(this.sectorRepo, allEntities, ['tsCode', 'tradeDate']);
    return { success, skipped, errors };
  }

  async syncMarket(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const allTradeDates = await this.getTradeDates(dto)
      .catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!allTradeDates.length) {
      this.logger.warn('未获取到交易日', dto);
      return { success: 0, skipped: 0, errors };
    }

    let tradeDates = allTradeDates;
    let skipped = 0;
    if (dto.syncMode !== 'overwrite') {
      const filtered = await this.filterExistingDates(this.marketRepo, allTradeDates);
      tradeDates = filtered.dates;
      skipped = filtered.skipped;
      if (!tradeDates.length) return { success: 0, skipped, errors };
    }

    // moneyflow_mkt_dc returns amounts in 元; divide by 10000 to unify with other money-flow tables (万元)
    const amountDivisor = 10000;
    const allEntities: MoneyFlowMarketEntity[] = [];

    for (const date of tradeDates) {
      const rows = await this.tushareClient.query(
        'moneyflow_mkt_dc',
        { start_date: date, end_date: date },
        MARKET_FIELDS,
      ).catch((e: unknown) => { errors.push(`[${date}] ${String(e)}`); return []; });

      if (rows.length >= 6000) {
        this.logger.warn(`moneyflow_mkt_dc ${date} 返回 ${rows.length} 条，可能截断`);
      }

      for (const row of rows) {
        allEntities.push(this.marketRepo.create({
          tradeDate: asString(row.trade_date),
          netAmount: asNullableNumeric(row.net_amount, amountDivisor),
          buyLgAmount: asNullableNumeric(row.buy_lg_amount, amountDivisor),
          buySmAmount: asNullableNumeric(row.buy_sm_amount, amountDivisor),
        }));
      }
    }

    const success = await this.batchUpsert(this.marketRepo, allEntities, ['tradeDate']);
    return { success, skipped, errors };
  }
}
