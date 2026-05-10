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

  async syncCatalog(_type: 'I' | 'N', _ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    return { success: 0, skipped: 0, errors: [] };
  }

  async syncMembers(_type: 'I' | 'N', _ctx?: SyncCtx): Promise<MoneyFlowSyncResult> {
    return { success: 0, skipped: 0, errors: [] };
  }

  async cleanupOrphans(): Promise<MoneyFlowSyncResult> {
    return { success: 0, skipped: 0, errors: [] };
  }

  startSync(): Subject<MoneyFlowSyncEvent> {
    const subject = new Subject<MoneyFlowSyncEvent>();
    subject.next({ type: 'error', message: 'startSync 尚未实现' });
    subject.complete();
    return subject;
  }
}
