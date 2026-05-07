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

// TODO: 需集成测试验证 API 契约（行业/板块/大盘接口名以官方文档为准）
const STOCK_FIELDS = 'trade_date,ts_code,name,pct_change,latest,net_amount,net_d5_amount,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate';
const INDUSTRY_FIELDS = 'trade_date,industry,pct_change,net_amount,buy_lg_amount,buy_md_amount,buy_sm_amount'; // 查文档确认
const SECTOR_FIELDS = 'trade_date,sector,pct_change,net_amount,buy_lg_amount,buy_md_amount,buy_sm_amount'; // 查文档确认，sector 字段名以文档为准
const MARKET_FIELDS = 'trade_date,net_amount,buy_lg_amount,buy_sm_amount,hk_net_amount'; // 查文档确认

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

    const chunkSize = 1000;
    for (let i = 0; i < entities.length; i += chunkSize) {
      await this.stockRepo.upsert(entities.slice(i, i + chunkSize), ['tsCode', 'tradeDate']);
    }
    success = entities.length;
    return { success, skipped: 0, errors };
  }

  async syncIndustries(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const rows = await this.tushareClient.query(
      'moneyflow_industry_ths', // TODO: 查文档确认
      { start_date: dto.start_date, end_date: dto.end_date },
      INDUSTRY_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_industry_ths 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.industryRepo.create({
        tradeDate: asString(row.trade_date),
        industry: asString(row.industry),
        pctChange: asNullableNumeric(row.pct_change),
        netAmount: asNullableNumeric(row.net_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buyMdAmount: asNullableNumeric(row.buy_md_amount),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
      }),
    );

    const chunkSize = 1000;
    for (let i = 0; i < entities.length; i += chunkSize) {
      await this.industryRepo.upsert(entities.slice(i, i + chunkSize), ['industry', 'tradeDate']);
    }
    return { success: entities.length, skipped: 0, errors };
  }

  async syncSectors(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const rows = await this.tushareClient.query(
      'moneyflow_sector_ths', // TODO: 查文档确认
      { start_date: dto.start_date, end_date: dto.end_date },
      SECTOR_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_sector_ths 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.sectorRepo.create({
        tradeDate: asString(row.trade_date),
        sector: asString(row.sector),
        pctChange: asNullableNumeric(row.pct_change),
        netAmount: asNullableNumeric(row.net_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buyMdAmount: asNullableNumeric(row.buy_md_amount),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
      }),
    );

    const chunkSize = 1000;
    for (let i = 0; i < entities.length; i += chunkSize) {
      await this.sectorRepo.upsert(entities.slice(i, i + chunkSize), ['sector', 'tradeDate']);
    }
    return { success: entities.length, skipped: 0, errors };
  }

  async syncMarket(dto: SyncFlowDto): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const rows = await this.tushareClient.query(
      'moneyflow_dc', // TODO: 查文档确认
      { start_date: dto.start_date, end_date: dto.end_date },
      MARKET_FIELDS,
    ).catch((e: unknown) => { errors.push(String(e)); return []; });

    if (!rows.length) {
      this.logger.warn('moneyflow_dc 返回空数据', dto);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((row) =>
      this.marketRepo.create({
        tradeDate: asString(row.trade_date),
        netAmount: asNullableNumeric(row.net_amount),
        buyLgAmount: asNullableNumeric(row.buy_lg_amount),
        buySmAmount: asNullableNumeric(row.buy_sm_amount),
        hkNetAmount: asNullableNumeric(row.hk_net_amount),
      }),
    );

    const chunkSize = 1000;
    for (let i = 0; i < entities.length; i += chunkSize) {
      await this.marketRepo.upsert(entities.slice(i, i + chunkSize), ['tradeDate']);
    }
    return { success: entities.length, skipped: 0, errors };
  }
}
