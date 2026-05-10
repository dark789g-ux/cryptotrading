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
    subject.next({ type: 'error', message: 'startSync 尚未实现' });
    subject.complete();
    return subject;
  }
}
