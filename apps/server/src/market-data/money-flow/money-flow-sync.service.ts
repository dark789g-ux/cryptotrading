// apps/server/src/market-data/money-flow/money-flow-sync.service.ts
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { Subject } from 'rxjs';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { resolveOpenTradeDates } from '../a-shares/sync/a-shares-sync-utils';
import { SyncFlowDto } from './dto/sync-flow.dto';
import type { MoneyFlowSyncEvent, MoneyFlowSyncResult, MoneyFlowSyncSummary } from '@cryptotrading/shared-types';
import {
  SyncCtx,
  asNullableNumeric,
  asString,
  batchUpsert,
  fetchByDates,
  filterExistingDates,
} from './money-flow-sync.helpers';

export type { MoneyFlowSyncResult };

// moneyflow_ths: https://tushare.pro/wctapi/documents/348.md
const STOCK_FIELDS = 'trade_date,ts_code,name,pct_change,latest,net_amount,net_d5_amount,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate';
// moneyflow_ind_ths: https://tushare.pro/document/2?doc_id=343
const INDUSTRY_FIELDS = 'trade_date,ts_code,industry,pct_change,net_buy_amount,net_sell_amount,net_amount';
// moneyflow_cnt_ths: https://tushare.pro/document/2?doc_id=371
const SECTOR_FIELDS = 'trade_date,ts_code,name,pct_change,net_buy_amount,net_sell_amount,net_amount';
// moneyflow_mkt_dc: https://tushare.pro/wctapi/documents/345.md
const MARKET_FIELDS = 'trade_date,net_amount,buy_lg_amount,buy_sm_amount';

interface RawRow {
  [k: string]: unknown;
}

@Injectable()
export class MoneyFlowSyncService {
  private readonly logger = new Logger(MoneyFlowSyncService.name);
  private isSyncing = false;

  constructor(
    @InjectRepository(MoneyFlowStockEntity)
    private readonly stockRepo: Repository<MoneyFlowStockEntity>,
    @InjectRepository(MoneyFlowIndustryEntity)
    private readonly industryRepo: Repository<MoneyFlowIndustryEntity>,
    @InjectRepository(MoneyFlowSectorEntity)
    private readonly sectorRepo: Repository<MoneyFlowSectorEntity>,
    @InjectRepository(MoneyFlowMarketEntity)
    private readonly marketRepo: Repository<MoneyFlowMarketEntity>,
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  private async getTradeDates(dto: SyncFlowDto): Promise<string[]> {
    try {
      return await resolveOpenTradeDates(this.tushareClient, {
        startDate: dto.start_date,
        endDate: dto.end_date,
      });
    } catch (e: unknown) {
      this.logger.error(
        `trade_cal 调用失败 start=${dto.start_date} end=${dto.end_date}: ${e instanceof Error ? e.message : String(e)}`,
        e instanceof Error ? e.stack : undefined,
      );
      throw e;
    }
  }

  private async resolveDates<T extends { tradeDate: string }>(
    dto: SyncFlowDto,
    repo: Repository<T>,
    errors: string[],
  ): Promise<{ dates: string[]; skipped: number; allDates: string[] } | null> {
    let allDates: string[];
    try {
      allDates = await this.getTradeDates(dto);
    } catch (e: unknown) {
      errors.push(`trade_cal: ${e instanceof Error ? e.message : String(e)}`);
      return null;
    }
    if (!allDates.length) {
      this.logger.warn(`trade_cal 返回 0 个交易日，参数 start=${dto.start_date} end=${dto.end_date}`);
      return null;
    }
    if (dto.syncMode === 'overwrite') {
      this.logger.log(`overwrite 模式：跳过增量过滤，全量重拉 ${allDates.length} 个交易日`);
      return { dates: allDates, skipped: 0, allDates };
    }
    const filtered = await filterExistingDates(repo, allDates);
    return { dates: filtered.dates, skipped: filtered.skipped, allDates };
  }

  async syncStocks(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const resolved = await this.resolveDates(dto, this.stockRepo, errors);
    if (!resolved) return { success: 0, skipped: 0, errors };
    if (!resolved.dates.length) return { success: 0, skipped: resolved.skipped, errors };

    const { rowsByDate, errors: fetchErrors } = await fetchByDates<RawRow>({
      apiName: 'moneyflow_ths',
      fields: STOCK_FIELDS,
      dates: resolved.dates,
      ctx,
      logger: this.logger,
      client: this.tushareClient,
    });
    errors.push(...fetchErrors);

    const allEntities: MoneyFlowStockEntity[] = [];
    for (const { rows } of rowsByDate) {
      for (const row of rows) {
        allEntities.push(this.stockRepo.create({
          tsCode: asString(row.ts_code),
          tradeDate: asString(row.trade_date),
          name: asString(row.name) || null,
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

    // moneyflow_ths 可能不返回 name，从 a_share_symbols 补充
    const missing = allEntities.filter((e) => !e.name);
    if (missing.length) {
      const tsCodes = [...new Set(missing.map((e) => e.tsCode))];
      const symbols = await this.symbolRepo
        .createQueryBuilder('s')
        .select(['s.tsCode', 's.name'])
        .where('s.tsCode IN (:...codes)', { codes: tsCodes })
        .getMany();
      const nameMap = new Map(symbols.map((s) => [s.tsCode, s.name]));
      for (const entity of missing) entity.name = nameMap.get(entity.tsCode) ?? null;
      if (symbols.length < tsCodes.length) {
        this.logger.warn(
          `[moneyflow_ths] ${tsCodes.length - symbols.length} 个 ts_code 在 a_share_symbols 中未找到名称`,
        );
      }
    }

    const success = await batchUpsert(this.stockRepo, allEntities, ['tsCode', 'tradeDate']);
    return { success, skipped: resolved.skipped, errors };
  }

  async syncIndustries(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const resolved = await this.resolveDates(dto, this.industryRepo, errors);
    if (!resolved) return { success: 0, skipped: 0, errors };
    if (!resolved.dates.length) {
      return { success: 0, skipped: resolved.skipped, errors };
    }

    const { rowsByDate, errors: fetchErrors } = await fetchByDates<RawRow>({
      apiName: 'moneyflow_ind_ths',
      fields: INDUSTRY_FIELDS,
      dates: resolved.dates,
      ctx,
      logger: this.logger,
      client: this.tushareClient,
    });
    errors.push(...fetchErrors);

    // moneyflow_ind_ths 金额单位为亿元，乘以 10000 统一为万元
    const toWanYuan = (v: unknown) => asNullableNumeric(v != null ? Number(v) * 10000 : v);
    const allEntities: MoneyFlowIndustryEntity[] = [];
    for (const { rows } of rowsByDate) {
      for (const row of rows) {
        allEntities.push(this.industryRepo.create({
          tradeDate: asString(row.trade_date),
          tsCode: asString(row.ts_code),
          industry: asString(row.industry),
          pctChange: asNullableNumeric(row.pct_change),
          netBuyAmount: toWanYuan(row.net_buy_amount),
          netSellAmount: toWanYuan(row.net_sell_amount),
          netAmount: toWanYuan(row.net_amount),
        }));
      }
    }
    const success = await batchUpsert(this.industryRepo, allEntities, ['tsCode', 'tradeDate']);
    return { success, skipped: resolved.skipped, errors };
  }

  async syncSectors(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const resolved = await this.resolveDates(dto, this.sectorRepo, errors);
    if (!resolved) return { success: 0, skipped: 0, errors };
    if (!resolved.dates.length) {
      return { success: 0, skipped: resolved.skipped, errors };
    }

    const { rowsByDate, errors: fetchErrors } = await fetchByDates<RawRow>({
      apiName: 'moneyflow_cnt_ths',
      fields: SECTOR_FIELDS,
      dates: resolved.dates,
      ctx,
      logger: this.logger,
      client: this.tushareClient,
    });
    errors.push(...fetchErrors);

    const toWanYuan = (v: unknown) => asNullableNumeric(v != null ? Number(v) * 10000 : v);
    const allEntities: MoneyFlowSectorEntity[] = [];
    for (const { rows } of rowsByDate) {
      for (const row of rows) {
        allEntities.push(this.sectorRepo.create({
          tradeDate: asString(row.trade_date),
          tsCode: asString(row.ts_code),
          sector: asString(row.name),
          pctChange: asNullableNumeric(row.pct_change),
          netBuyAmount: toWanYuan(row.net_buy_amount),
          netSellAmount: toWanYuan(row.net_sell_amount),
          netAmount: toWanYuan(row.net_amount),
        }));
      }
    }
    const success = await batchUpsert(this.sectorRepo, allEntities, ['tsCode', 'tradeDate']);
    return { success, skipped: resolved.skipped, errors };
  }

  async syncMarket(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const resolved = await this.resolveDates(dto, this.marketRepo, errors);
    if (!resolved) return { success: 0, skipped: 0, errors };
    if (!resolved.dates.length) return { success: 0, skipped: resolved.skipped, errors };

    const { rowsByDate, errors: fetchErrors } = await fetchByDates<RawRow>({
      apiName: 'moneyflow_mkt_dc',
      fields: MARKET_FIELDS,
      dates: resolved.dates,
      ctx,
      logger: this.logger,
      client: this.tushareClient,
    });
    errors.push(...fetchErrors);

    // moneyflow_mkt_dc 金额单位为元，除以 10000 统一为万元
    const amountDivisor = 10000;
    const allEntities: MoneyFlowMarketEntity[] = [];
    for (const { rows } of rowsByDate) {
      for (const row of rows) {
        allEntities.push(this.marketRepo.create({
          tradeDate: asString(row.trade_date),
          netAmount: asNullableNumeric(row.net_amount, amountDivisor),
          buyLgAmount: asNullableNumeric(row.buy_lg_amount, amountDivisor),
          buySmAmount: asNullableNumeric(row.buy_sm_amount, amountDivisor),
        }));
      }
    }

    const success = await batchUpsert(this.marketRepo, allEntities, ['tradeDate']);
    return { success, skipped: resolved.skipped, errors };
  }

  startSync(dto: SyncFlowDto): Subject<MoneyFlowSyncEvent> {
    const subject = new Subject<MoneyFlowSyncEvent>();

    if (this.isSyncing) {
      subject.next({ type: 'error', message: '资金流同步任务已在运行中，请稍后再试' });
      subject.complete();
      return subject;
    }
    this.isSyncing = true;

    setTimeout(async () => {
      const summary: Partial<MoneyFlowSyncSummary> = {};
      try {
        let allTradeDates: string[];
        try {
          allTradeDates = await this.getTradeDates(dto);
        } catch (e: unknown) {
          subject.next({
            type: 'error',
            message: `获取交易日列表失败: ${e instanceof Error ? e.message : String(e)}`,
          });
          subject.complete();
          return;
        }
        if (!allTradeDates.length) {
          subject.next({ type: 'error', message: '未获取到交易日列表' });
          subject.complete();
          return;
        }

        const dims = [
          { key: 'stocks' as const,     label: '同步个股资金流' },
          { key: 'industries' as const, label: '同步行业资金流' },
          { key: 'sectors' as const,    label: '同步板块资金流' },
          { key: 'market' as const,     label: '同步大盘资金流' },
        ];

        const totals = dims.map(() => allTradeDates.length);
        const grandTotal = totals.reduce((a, b) => a + b, 0) || 1;

        let baseCurrent = 0;
        for (let i = 0; i < dims.length; i++) {
          const ctx: SyncCtx = {
            phase: dims[i].label,
            baseCurrent,
            total: totals[i],
            grandTotal,
            emit: (e) => subject.next(e),
          };
          summary[dims[i].key] = await this.runDimension(dims[i].key, dto, ctx);
          baseCurrent += totals[i];
        }

        const failedCount = (Object.values(summary) as MoneyFlowSyncResult[])
          .reduce((n, r) => n + (r?.errors.length ?? 0), 0);
        subject.next({
          type: 'done',
          message: failedCount ? `同步完成，${failedCount} 个交易日失败` : '同步完成',
          summary: summary as MoneyFlowSyncSummary,
        });
        subject.complete();
      } catch (err) {
        this.logger.error(`startSync 失败: ${err instanceof Error ? err.stack : String(err)}`);
        subject.next({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          summary: summary as MoneyFlowSyncSummary,
        });
        subject.complete();
      } finally {
        this.isSyncing = false;
      }
    }, 0);

    return subject;
  }

  private runDimension(
    key: 'stocks' | 'industries' | 'sectors' | 'market',
    dto: SyncFlowDto,
    ctx: SyncCtx,
  ): Promise<MoneyFlowSyncResult> {
    switch (key) {
      case 'stocks':     return this.syncStocks(dto, ctx);
      case 'industries': return this.syncIndustries(dto, ctx);
      case 'sectors':    return this.syncSectors(dto, ctx);
      case 'market':     return this.syncMarket(dto, ctx);
    }
  }
}
