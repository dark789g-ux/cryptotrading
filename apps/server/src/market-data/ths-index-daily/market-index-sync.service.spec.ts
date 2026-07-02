/**
 * MarketIndexSyncService 单元测试。
 *
 * 核心覆盖：dto.syncMode 被读取并记录。本 service 无「跳过已有 (ts_code, trade_date)」逻辑
 * （逐指数全量重拉 + upsert 即覆盖），故 syncMode 为 no-op —— 测试同时验证
 * incremental 与 overwrite 的 upsert 行为完全一致，为「no-op」标注提供证据。
 *
 * 注意：本文件 mock 了 TushareClientService.query，无法发现 index_daily 真实接口名/字段变更
 * —— 集成测试应另行覆盖。
 */
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { Logger } from '@nestjs/common';
import { MarketIndexSyncService } from './market-index-sync.service';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { ThsIndexDailyIndicatorService } from './ths-index-daily-indicator.service';

function makeQuotesRepo() {
  return {
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
    upsert: jest.fn().mockResolvedValue({}),
  };
}

const RAW_ROW = {
  ts_code: '000001.SH',
  trade_date: '20260101',
  open: 1,
  high: 1,
  low: 1,
  close: 1,
  pre_close: 1,
  change: 0,
  pct_chg: 0,
  vol: 10,
  amount: 100,
};

describe('MarketIndexSyncService', () => {
  let service: MarketIndexSyncService;
  let quotesRepo: ReturnType<typeof makeQuotesRepo>;
  let catalogRepo: { find: jest.Mock };
  let client: { query: jest.Mock };
  let indicatorService: { recalculateForSymbols: jest.Mock };

  beforeEach(async () => {
    quotesRepo = makeQuotesRepo();
    catalogRepo = { find: jest.fn().mockResolvedValue([{ tsCode: '000001.SH' }]) };
    client = { query: jest.fn().mockResolvedValue([RAW_ROW]) };
    indicatorService = { recalculateForSymbols: jest.fn().mockResolvedValue(0) };

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MarketIndexSyncService,
        { provide: getRepositoryToken(IndexDailyQuoteEntity), useValue: quotesRepo },
        { provide: getRepositoryToken(ThsIndexCatalogEntity), useValue: catalogRepo },
        { provide: TushareClientService, useValue: client },
        { provide: ThsIndexDailyIndicatorService, useValue: indicatorService },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(MarketIndexSyncService);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('读取 dto.syncMode 并记录（含 no-op 标注）', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    // catalog 空 → market_scope_empty 提前 return；但 syncMode log 在方法入口，已打
    catalogRepo.find.mockResolvedValue([]);

    await service.sync({
      start_date: '20260101',
      end_date: '20260102',
      syncMode: 'overwrite',
    });

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('syncMode=overwrite'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('no-op'));
  });

  it('不传 syncMode 时默认 incremental 并记录', async () => {
    const logSpy = jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
    catalogRepo.find.mockResolvedValue([]);

    await service.sync({ start_date: '20260101', end_date: '20260102' });

    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining('syncMode=incremental'),
    );
  });

  it('syncMode 对落库行为为 no-op：overwrite 与 incremental 的 upsert 调用完全一致', async () => {
    catalogRepo.find.mockResolvedValue([{ tsCode: '000001.SH' }]);
    client.query.mockResolvedValue([RAW_ROW]);

    // overwrite
    quotesRepo.upsert.mockClear();
    await service.sync({
      start_date: '20260101',
      end_date: '20260101',
      syncMode: 'overwrite',
    });
    const overwriteCalls = quotesRepo.upsert.mock.calls.slice();

    // incremental
    quotesRepo.upsert.mockClear();
    await service.sync({
      start_date: '20260101',
      end_date: '20260101',
      syncMode: 'incremental',
    });
    const incrementalCalls = quotesRepo.upsert.mock.calls.slice();

    // 调用次数与参数结构一致 → 证明 syncMode 不改变落库行为（真 no-op）
    expect(overwriteCalls).toHaveLength(incrementalCalls.length);
    expect(overwriteCalls).toEqual(incrementalCalls);
  });
});
