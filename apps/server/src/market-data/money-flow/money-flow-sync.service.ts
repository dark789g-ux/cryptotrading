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
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { resolveOpenTradeDates } from '../a-shares/sync/a-shares-sync-utils';
import { SyncFlowDto } from './dto/sync-flow.dto';
import type { MoneyFlowSyncEvent, MoneyFlowSyncResult, MoneyFlowSyncSummary } from '@cryptotrading/shared-types';

export type { MoneyFlowSyncResult };

// moneyflow_ths: https://tushare.pro/wctapi/documents/348.md
const STOCK_FIELDS = 'trade_date,ts_code,name,pct_change,latest,net_amount,net_d5_amount,buy_lg_amount,buy_lg_amount_rate,buy_md_amount,buy_md_amount_rate,buy_sm_amount,buy_sm_amount_rate';
// moneyflow_ind_ths: https://tushare.pro/document/2?doc_id=343
const INDUSTRY_FIELDS = 'trade_date,ts_code,industry,pct_change,net_buy_amount,net_sell_amount,net_amount';
// moneyflow_cnt_ths: https://tushare.pro/document/2?doc_id=371
const SECTOR_FIELDS = 'trade_date,ts_code,name,pct_change,net_buy_amount,net_sell_amount,net_amount';
// moneyflow_mkt_dc: https://tushare.pro/wctapi/documents/345.md
const MARKET_FIELDS = 'trade_date,net_amount,buy_lg_amount,buy_sm_amount';
// ths_member: https://tushare.pro/wctapi/documents/261.md
const MEMBER_FIELDS = 'ts_code,con_code,con_name,is_new';

type SyncCtx = {
  phase: string;
  baseCurrent: number;
  total: number;
  grandTotal: number;
  emit: (e: MoneyFlowSyncEvent) => void;
};

function pctOf(c: number, g: number): number {
  return Math.round((c / Math.max(g, 1)) * 100);
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + '…' : s;
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
    @InjectRepository(AShareSymbolEntity)
    private readonly symbolRepo: Repository<AShareSymbolEntity>,
    @InjectRepository(ThsMemberStockEntity)
    private readonly memberRepo: Repository<ThsMemberStockEntity>,
    private readonly tushareClient: TushareClientService,
  ) {}

  private async runWithRetry<T>(
    fn: () => Promise<T>,
    onRetry: (attempt: number, err: unknown) => void,
  ): Promise<T> {
    const backoffs = [1000, 2000];
    let lastErr: unknown;
    for (let attempt = 0; attempt <= backoffs.length; attempt++) {
      try {
        return await fn();
      } catch (e) {
        lastErr = e;
        if (attempt < backoffs.length) {
          onRetry(attempt + 1, e);
          await new Promise((r) => setTimeout(r, backoffs[attempt]));
        }
      }
    }
    throw lastErr;
  }

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

  async syncStocks(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
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

    for (let i = 0; i < tradeDates.length; i++) {
      const date = tradeDates[i];
      let rows: any[] = [];
      try {
        rows = await this.runWithRetry(
          () => this.tushareClient.query('moneyflow_ths', { start_date: date, end_date: date }, STOCK_FIELDS),
          (attempt, err) => ctx?.emit({
            type: 'progress',
            phase: ctx.phase,
            current: ctx.baseCurrent + i,
            total: ctx.total,
            percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
            message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
          }),
        );
      } catch (e) {
        errors.push(`[${date}] ${String(e)}`);
      }

      if (rows.length >= 6000) {
        this.logger.warn(`moneyflow_ths ${date} 返回 ${rows.length} 条，可能截断`);
      }

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

      ctx?.emit({
        type: 'progress',
        phase: ctx.phase,
        current: ctx.baseCurrent + i + 1,
        total: ctx.total,
        percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
        message: date,
      });
    }

    // Tushare moneyflow_ths 可能不返回 name 字段，从 a_share_symbols 补充
    const missingNameEntities = allEntities.filter((e) => !e.name);
    if (missingNameEntities.length) {
      const tsCodes = [...new Set(missingNameEntities.map((e) => e.tsCode))];
      const symbols = await this.symbolRepo
        .createQueryBuilder('s')
        .select(['s.tsCode', 's.name'])
        .where('s.tsCode IN (:...codes)', { codes: tsCodes })
        .getMany();
      const nameMap = new Map(symbols.map((s) => [s.tsCode, s.name]));
      for (const entity of missingNameEntities) {
        entity.name = nameMap.get(entity.tsCode) ?? null;
      }
      if (symbols.length < tsCodes.length) {
        this.logger.warn(
          `[moneyflow_ths] ${tsCodes.length - symbols.length} 个 ts_code 在 a_share_symbols 中未找到名称`,
        );
      }
    }

    const success = await this.batchUpsert(this.stockRepo, allEntities, ['tsCode', 'tradeDate']);
    return { success, skipped, errors };
  }

  async syncIndustries(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
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

    // moneyflow_ind_ths 金额单位为亿元，乘以 10000 统一为万元
    const toWanYuan = (v: unknown) => asNullableNumeric(v != null ? Number(v) * 10000 : v);
    const allEntities: MoneyFlowIndustryEntity[] = [];

    for (let i = 0; i < tradeDates.length; i++) {
      const date = tradeDates[i];
      let rows: any[] = [];
      try {
        rows = await this.runWithRetry(
          () => this.tushareClient.query('moneyflow_ind_ths', { start_date: date, end_date: date }, INDUSTRY_FIELDS),
          (attempt, err) => ctx?.emit({
            type: 'progress',
            phase: ctx.phase,
            current: ctx.baseCurrent + i,
            total: ctx.total,
            percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
            message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
          }),
        );
      } catch (e) {
        errors.push(`[${date}] ${String(e)}`);
      }

      if (rows.length >= 6000) {
        this.logger.warn(`moneyflow_ind_ths ${date} 返回 ${rows.length} 条，可能截断`);
      }

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

      ctx?.emit({
        type: 'progress',
        phase: ctx.phase,
        current: ctx.baseCurrent + i + 1,
        total: ctx.total,
        percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
        message: date,
      });
    }

    const success = await this.batchUpsert(this.industryRepo, allEntities, ['tsCode', 'tradeDate']);

    // 行业资金流同步完成后，自动同步成分股映射
    const memberResult = await this.syncMembers('industry');
    if (memberResult.errors.length) {
      errors.push(...memberResult.errors);
    }
    this.logger.log(`syncIndustries 完成: 资金流 ${success} 条, 成分股 ${memberResult.success} 条`);

    return { success, skipped, errors };
  }

  async syncSectors(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
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

    // moneyflow_cnt_ths 金额单位为亿元，乘以 10000 统一为万元
    const toWanYuan = (v: unknown) => asNullableNumeric(v != null ? Number(v) * 10000 : v);
    const allEntities: MoneyFlowSectorEntity[] = [];

    for (let i = 0; i < tradeDates.length; i++) {
      const date = tradeDates[i];
      let rows: any[] = [];
      try {
        rows = await this.runWithRetry(
          () => this.tushareClient.query('moneyflow_cnt_ths', { start_date: date, end_date: date }, SECTOR_FIELDS),
          (attempt, err) => ctx?.emit({
            type: 'progress',
            phase: ctx.phase,
            current: ctx.baseCurrent + i,
            total: ctx.total,
            percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
            message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
          }),
        );
      } catch (e) {
        errors.push(`[${date}] ${String(e)}`);
      }

      if (rows.length >= 6000) {
        this.logger.warn(`moneyflow_cnt_ths ${date} 返回 ${rows.length} 条，可能截断`);
      }

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

      ctx?.emit({
        type: 'progress',
        phase: ctx.phase,
        current: ctx.baseCurrent + i + 1,
        total: ctx.total,
        percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
        message: date,
      });
    }

    const success = await this.batchUpsert(this.sectorRepo, allEntities, ['tsCode', 'tradeDate']);

    // 板块资金流同步完成后，自动同步成分股映射
    const memberResult = await this.syncMembers('sector');
    if (memberResult.errors.length) {
      errors.push(...memberResult.errors);
    }
    this.logger.log(`syncSectors 完成: 资金流 ${success} 条, 成分股 ${memberResult.success} 条`);

    return { success, skipped, errors };
  }

  async syncMarket(dto: SyncFlowDto, ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
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

    for (let i = 0; i < tradeDates.length; i++) {
      const date = tradeDates[i];
      let rows: any[] = [];
      try {
        rows = await this.runWithRetry(
          () => this.tushareClient.query('moneyflow_mkt_dc', { start_date: date, end_date: date }, MARKET_FIELDS),
          (attempt, err) => ctx?.emit({
            type: 'progress',
            phase: ctx.phase,
            current: ctx.baseCurrent + i,
            total: ctx.total,
            percent: pctOf(ctx.baseCurrent + i, ctx.grandTotal),
            message: `重试中：${date}（第 ${attempt}/2 次） ${truncate(String(err), 60)}`,
          }),
        );
      } catch (e) {
        errors.push(`[${date}] ${String(e)}`);
      }

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

      ctx?.emit({
        type: 'progress',
        phase: ctx.phase,
        current: ctx.baseCurrent + i + 1,
        total: ctx.total,
        percent: pctOf(ctx.baseCurrent + i + 1, ctx.grandTotal),
        message: date,
      });
    }

    const success = await this.batchUpsert(this.marketRepo, allEntities, ['tradeDate']);
    return { success, skipped, errors };
  }

  /**
   * 同步行业/板块成分股映射。
   * @param dimension 'industry' | 'sector' — 决定从哪张表取 ts_code 列表
   */
  async syncMembers(dimension: 'industry' | 'sector'): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    const repo = dimension === 'industry' ? this.industryRepo : this.sectorRepo;

    // 从已同步的资金流表中取 DISTINCT ts_code
    const rows = await repo
      .createQueryBuilder('e')
      .select('DISTINCT e.ts_code', 'tsCode')
      .getRawMany<{ tsCode: string }>();
    const tsCodes = rows.map(r => r.tsCode).filter(Boolean);

    if (!tsCodes.length) {
      this.logger.warn(`syncMembers(${dimension}): 无 ts_code，请先同步${dimension === 'industry' ? '行业' : '板块'}资金流数据`);
      return { success: 0, skipped: 0, errors };
    }

    let success = 0;
    for (const tsCode of tsCodes) {
      try {
        const memberRows = await this.tushareClient.query(
          'ths_member',
          { ts_code: tsCode },
          MEMBER_FIELDS,
        );

        if (!memberRows.length) {
          this.logger.warn(`ths_member(${tsCode}) 返回空数据`);
          continue;
        }

        // 先删除该 ts_code 的旧数据，再批量插入
        await this.memberRepo.createQueryBuilder()
          .delete()
          .where('ts_code = :tsCode', { tsCode })
          .execute();

        const entities = memberRows.map(r => this.memberRepo.create({
          tsCode: asString(r.ts_code),
          conCode: asString(r.con_code),
          conName: asString(r.con_name) || null,
          isNew: asString(r.is_new) || null,
        }));

        const deduped = deduplicateBy(entities, ['tsCode', 'conCode']);
        const chunkSize = 1000;
        for (let i = 0; i < deduped.length; i += chunkSize) {
          await this.memberRepo.upsert(deduped.slice(i, i + chunkSize) as any, ['tsCode', 'conCode']);
        }
        success += deduped.length;
      } catch (e: unknown) {
        const msg = `[${tsCode}] ${String(e)}`;
        this.logger.warn(`syncMembers(${dimension}) 失败: ${msg}`);
        errors.push(msg);
      }
    }

    return { success, skipped: 0, errors };
  }

  startSync(dto: SyncFlowDto): Subject<MoneyFlowSyncEvent> {
    const subject = new Subject<MoneyFlowSyncEvent>();

    setTimeout(async () => {
      try {
        const allTradeDates = await this.getTradeDates(dto);
        if (!allTradeDates.length) {
          subject.next({ type: 'error', message: '未获取到交易日列表' });
          subject.complete();
          return;
        }

        const dims = [
          { key: 'stocks' as const,     label: '同步个股资金流', method: 'syncStocks' as const },
          { key: 'industries' as const, label: '同步行业资金流', method: 'syncIndustries' as const },
          { key: 'sectors' as const,    label: '同步板块资金流', method: 'syncSectors' as const },
          { key: 'market' as const,     label: '同步大盘资金流', method: 'syncMarket' as const },
        ];

        const totals = dims.map(() => allTradeDates.length);
        const grandTotal = totals.reduce((a, b) => a + b, 0) || 1;

        const summary: Partial<MoneyFlowSyncSummary> = {};
        let baseCurrent = 0;
        for (let i = 0; i < dims.length; i++) {
          const ctx: SyncCtx = {
            phase: dims[i].label,
            baseCurrent,
            total: totals[i],
            grandTotal,
            emit: (e) => subject.next(e),
          };
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          summary[dims[i].key] = await (this[dims[i].method] as any).call(this, dto, ctx);
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
        subject.next({ type: 'error', message: err instanceof Error ? err.message : String(err) });
        subject.complete();
      }
    }, 0);

    return subject;
  }
}
