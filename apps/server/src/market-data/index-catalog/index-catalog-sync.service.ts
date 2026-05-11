import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository, InjectDataSource } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { Subject } from 'rxjs';
import type { MoneyFlowSyncEvent, MoneyFlowSyncResult, IndexCatalogSyncSummary } from '@cryptotrading/shared-types';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { SyncCtx, asString, batchUpsert, deduplicateBy } from '../_shared/sync-helpers';

// ths_index: https://tushare.pro/wctapi/documents/259.md
const CATALOG_FIELDS = 'ts_code,name,count,exchange,list_date,type';
// ths_member: https://tushare.pro/wctapi/documents/261.md
const MEMBER_FIELDS = 'ts_code,con_code,con_name,is_new';

interface RawRow {
  [k: string]: unknown;
}

@Injectable()
export class IndexCatalogSyncService {
  private readonly logger = new Logger(IndexCatalogSyncService.name);
  private isSyncing = false;

  constructor(
    @InjectRepository(ThsIndexCatalogEntity)
    private readonly catalogRepo: Repository<ThsIndexCatalogEntity>,
    @InjectRepository(ThsMemberStockEntity)
    private readonly memberRepo: Repository<ThsMemberStockEntity>,
    @InjectDataSource()
    private readonly dataSource: DataSource,
    private readonly tushareClient: TushareClientService,
  ) {}

  async syncCatalog(type: 'I' | 'N', _ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    let rows: RawRow[] = [];
    try {
      rows = (await this.tushareClient.query(
        'ths_index',
        { type, exchange: 'A' },
        CATALOG_FIELDS,
      )) as RawRow[];
    } catch (e: unknown) {
      const msg = `ths_index type=${type} 调用失败: ${e instanceof Error ? e.message : String(e)}`;
      this.logger.error(msg, e instanceof Error ? e.stack : undefined);
      errors.push(msg);
      return { success: 0, skipped: 0, errors };
    }

    if (!rows.length) {
      this.logger.warn(`[ths_index type=${type}] 返回空数据，参数={type:'${type}',exchange:'A'}`);
      return { success: 0, skipped: 0, errors };
    }

    const entities = rows.map((r) => this.catalogRepo.create({
      tsCode: asString(r.ts_code),
      name: asString(r.name),
      count: r.count != null ? Number(r.count) : null,
      exchange: asString(r.exchange),
      listDate: r.list_date != null ? asString(r.list_date) : null,
      type,
    }));

    const success = await batchUpsert(this.catalogRepo, entities, ['tsCode']);
    return { success, skipped: 0, errors };
  }

  async syncMembers(type: 'I' | 'N', _ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];

    const rows = await this.catalogRepo
      .createQueryBuilder('c')
      .select('c.ts_code', 'tsCode')
      .where('c.type = :type', { type })
      .getRawMany<{ tsCode: string }>();
    const tsCodes = rows.map((r) => r.tsCode).filter(Boolean);

    if (!tsCodes.length) {
      this.logger.warn(`syncMembers(type=${type}): ths_index_catalog 中无对应记录，请先同步目录`);
      return { success: 0, skipped: 0, errors };
    }

    let success = 0;
    for (const tsCode of tsCodes) {
      try {
        const memberRows = (await this.tushareClient.query(
          'ths_member',
          { ts_code: tsCode },
          MEMBER_FIELDS,
        )) as RawRow[];

        if (!memberRows.length) {
          this.logger.warn(`ths_member(${tsCode}) 返回空数据`);
          continue;
        }

        const entities = memberRows.map((r) => this.memberRepo.create({
          tsCode: asString(r.ts_code),
          conCode: asString(r.con_code),
          conName: asString(r.con_name) || null,
          isNew: asString(r.is_new) || null,
        }));
        const deduped = deduplicateBy(entities, ['tsCode', 'conCode']);

        await this.dataSource.transaction(async (manager) => {
          await manager.delete(ThsMemberStockEntity, { tsCode });
          const chunkSize = 1000;
          for (let i = 0; i < deduped.length; i += chunkSize) {
            await manager.upsert(
              ThsMemberStockEntity,
              deduped.slice(i, i + chunkSize),
              ['tsCode', 'conCode'],
            );
          }
        });
        success += 1;
      } catch (e: unknown) {
        const msg = `ths_member(${tsCode}) 失败: ${e instanceof Error ? e.message : String(e)}`;
        this.logger.error(msg, e instanceof Error ? e.stack : undefined);
        errors.push(`[${tsCode}] ${msg}`);
      }
    }

    return { success, skipped: 0, errors };
  }

  async cleanupOrphans(): Promise<MoneyFlowSyncResult> {
    const errors: string[] = [];
    try {
      const result = await this.memberRepo
        .createQueryBuilder()
        .delete()
        .from(ThsMemberStockEntity)
        .where('ts_code NOT IN (SELECT ts_code FROM ths_index_catalog)')
        .execute();
      const affected = result.affected ?? 0;
      if (affected > 0) {
        this.logger.log(`cleanupOrphans 删除 ${affected} 条孤儿成分股`);
      }
      return { success: affected, skipped: 0, errors };
    } catch (e: unknown) {
      const msg = `cleanupOrphans 失败: ${e instanceof Error ? e.message : String(e)}`;
      this.logger.error(msg, e instanceof Error ? e.stack : undefined);
      errors.push(msg);
      return { success: 0, skipped: 0, errors };
    }
  }

  startSync(): Subject<MoneyFlowSyncEvent> {
    const subject = new Subject<MoneyFlowSyncEvent>();

    if (this.isSyncing) {
      setTimeout(() => {
        subject.next({ type: 'error', message: '行业/概念目录同步任务已在运行中，请稍后再试' });
        subject.complete();
      }, 0);
      return subject;
    }
    this.isSyncing = true;

    setTimeout(async () => {
      const summary: Partial<IndexCatalogSyncSummary> = {};
      try {
        // Stage 1: 行业目录
        subject.next({ type: 'progress', phase: '同步行业目录', current: 0, total: 1, percent: 0, message: '开始' });
        summary.industryCatalog = await this.syncCatalog('I');
        subject.next({ type: 'progress', phase: '同步行业目录', current: 1, total: 1, percent: 20, message: `成功 ${summary.industryCatalog.success}` });
        if (summary.industryCatalog.errors.length) {
          subject.next({ type: 'error', message: '行业目录拉取失败：' + summary.industryCatalog.errors.join('; '), summary: summary as IndexCatalogSyncSummary });
          subject.complete();
          return;
        }

        // Stage 2: 概念目录
        subject.next({ type: 'progress', phase: '同步概念目录', current: 0, total: 1, percent: 20, message: '开始' });
        summary.conceptCatalog = await this.syncCatalog('N');
        subject.next({ type: 'progress', phase: '同步概念目录', current: 1, total: 1, percent: 40, message: `成功 ${summary.conceptCatalog.success}` });
        if (summary.conceptCatalog.errors.length) {
          subject.next({ type: 'error', message: '概念目录拉取失败：' + summary.conceptCatalog.errors.join('; '), summary: summary as IndexCatalogSyncSummary });
          subject.complete();
          return;
        }

        // Stage 3: 行业成分股
        subject.next({ type: 'progress', phase: '同步行业成分股', current: 0, total: 1, percent: 40, message: '开始' });
        summary.industryMembers = await this.syncMembers('I');
        subject.next({ type: 'progress', phase: '同步行业成分股', current: 1, total: 1, percent: 60, message: `成功 ${summary.industryMembers.success}` });

        // Stage 4: 概念成分股
        subject.next({ type: 'progress', phase: '同步概念成分股', current: 0, total: 1, percent: 60, message: '开始' });
        summary.conceptMembers = await this.syncMembers('N');
        subject.next({ type: 'progress', phase: '同步概念成分股', current: 1, total: 1, percent: 80, message: `成功 ${summary.conceptMembers.success}` });

        // Stage 5: 清理孤儿
        subject.next({ type: 'progress', phase: '清理孤儿成分股', current: 0, total: 1, percent: 80, message: '开始' });
        summary.cleanup = await this.cleanupOrphans();
        subject.next({ type: 'progress', phase: '清理孤儿成分股', current: 1, total: 1, percent: 100, message: `删除 ${summary.cleanup.success}` });

        const failedCount = (Object.values(summary) as MoneyFlowSyncResult[])
          .reduce((n, r) => n + (r?.errors.length ?? 0), 0);
        subject.next({
          type: 'done',
          message: failedCount ? `同步完成，${failedCount} 项有错误` : '同步完成',
          summary: summary as IndexCatalogSyncSummary,
        });
        subject.complete();
      } catch (err) {
        this.logger.error(`startSync 失败: ${err instanceof Error ? err.stack : String(err)}`);
        subject.next({
          type: 'error',
          message: err instanceof Error ? err.message : String(err),
          summary: summary as IndexCatalogSyncSummary,
        });
        subject.complete();
      } finally {
        this.isSyncing = false;
      }
    }, 0);

    return subject;
  }
}
