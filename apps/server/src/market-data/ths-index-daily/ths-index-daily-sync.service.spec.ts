// TODO: 需集成测试验证 API 契约 —— 本文件 mock 了 TushareClientService.query，
// 无法发现 ths_daily 真实接口名、字段名、单位变更。集成测试应覆盖：
//   1) ths_daily 真实响应 fields 顺序与 total_mv / float_mv / vol 单位
//   2) trade_cal 真实交易日序列
//   3) ths_index_catalog 真实 I+N 过滤
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { ThsIndexDailySyncService } from './ths-index-daily-sync.service';
import { ThsIndexDailyIndicatorService } from './ths-index-daily-indicator.service';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { ThsIndexCatalogEntity } from '../../entities/index-catalog/ths-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import * as syncUtils from '../a-shares/sync/a-shares-sync-utils';
import { Logger } from '@nestjs/common';

interface MockRepo {
  createQueryBuilder: jest.Mock;
  upsert: jest.Mock;
  create: jest.Mock;
}

function makeQuotesRepo(): MockRepo {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    andWhere: jest.fn().mockReturnThis(),
    orderBy: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue([]),
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    upsert: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
  };
}

function makeCatalogRepo(allowed: Array<{ tsCode: string; type: 'I' | 'N' }>): MockRepo {
  const qb: Record<string, jest.Mock> = {
    select: jest.fn().mockReturnThis(),
    where: jest.fn().mockReturnThis(),
    getMany: jest.fn().mockResolvedValue(allowed),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    upsert: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
  };
}

async function buildModule(opts: {
  catalog: Array<{ tsCode: string; type: 'I' | 'N' }>;
  indicatorService?: Partial<ThsIndexDailyIndicatorService>;
}): Promise<{
  service: ThsIndexDailySyncService;
  client: { query: jest.Mock };
  quotesRepo: MockRepo;
}> {
  const client = { query: jest.fn() };
  const quotesRepo = makeQuotesRepo();
  const catalogRepo = makeCatalogRepo(opts.catalog);

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      ThsIndexDailySyncService,
      { provide: getRepositoryToken(IndexDailyQuoteEntity), useValue: quotesRepo },
      { provide: getRepositoryToken(ThsIndexCatalogEntity), useValue: catalogRepo },
      { provide: TushareClientService, useValue: client },
      {
        provide: ThsIndexDailyIndicatorService,
        useValue: {
          recalculateForSymbols: jest.fn().mockResolvedValue(0),
          ...(opts.indicatorService ?? {}),
        },
      },
    ],
  }).compile();
  module.useLogger(false);

  return { service: module.get(ThsIndexDailySyncService), client, quotesRepo };
}

describe('ThsIndexDailySyncService', () => {
  beforeEach(() => {
    jest
      .spyOn(syncUtils, 'resolveOpenTradeDates')
      .mockResolvedValue(['20260512']);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('单位换算：total_mv/float_mv 元 → 万元 ÷10000，vol 不换算（仍为「手」）', async () => {
    const { service, client, quotesRepo } = await buildModule({
      catalog: [{ tsCode: '881101.TI', type: 'I' }],
    });
    client.query.mockResolvedValueOnce([
      {
        ts_code: '881101.TI',
        trade_date: '20260512',
        open: 1000.5,
        high: 1020.0,
        low: 990.0,
        close: 1010.0,
        pre_close: 1000.0,
        change: 10.0,
        pct_change: 1.0,
        vol: 12345.67,
        turnover_rate: 1.23,
        total_mv: 1_234_567_890_000, // 元
        float_mv: 1_000_000_000_000, // 元
      },
    ]);

    const result = await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    expect(result.success).toBe(1);
    expect(result.errors).toHaveLength(0);

    const upsertCalls = quotesRepo.upsert.mock.calls;
    expect(upsertCalls).toHaveLength(1);
    const [entities] = upsertCalls[0];
    expect(entities).toHaveLength(1);
    const entity = entities[0];
    expect(entity.tsCode).toBe('881101.TI');
    expect(entity.tradeDate).toBe('20260512');
    expect(entity.volHand).toBeCloseTo(12345.67);
    expect(entity.totalMvWan).toBe(String(1_234_567_890_000 / 10000));
    expect(entity.floatMvWan).toBe(String(1_000_000_000_000 / 10000));
  });

  it('空数据：返回 0 行时显式推送 failedItem: ths_daily_empty + params', async () => {
    const { service, client } = await buildModule({
      catalog: [{ tsCode: '881101.TI', type: 'I' }],
    });
    client.query.mockResolvedValueOnce([]);

    const result = await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    expect(result.success).toBe(0);
    expect(result.errors).toEqual([
      { apiName: 'ths_daily_empty', params: { trade_date: '20260512' } },
    ]);
  });

  it('重复 (ts_code, trade_date) 去重保留最后一条 + warn 原始/去重条数', async () => {
    const { service, client, quotesRepo } = await buildModule({
      catalog: [{ tsCode: '881101.TI', type: 'I' }],
    });
    client.query.mockResolvedValueOnce([
      {
        ts_code: '881101.TI', trade_date: '20260512',
        open: 1, high: 1, low: 1, close: 1, pre_close: 1, change: 0, pct_change: 0,
        vol: 10, turnover_rate: 0, total_mv: 10000, float_mv: 10000,
      },
      {
        ts_code: '881101.TI', trade_date: '20260512',
        open: 2, high: 2, low: 2, close: 2, pre_close: 2, change: 0, pct_change: 0,
        vol: 20, turnover_rate: 0, total_mv: 20000, float_mv: 20000,
      },
    ]);
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    expect(result.success).toBe(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('原始 2 行 → 去重后 1 行'));

    const [entities] = quotesRepo.upsert.mock.calls[0];
    expect(entities).toHaveLength(1);
    expect(entities[0].open).toBe(2); // 保留最后一条
  });

  it('用 ths_index_catalog 过滤：非 I/N type 的 ts_code 被静默丢弃', async () => {
    const { service, client, quotesRepo } = await buildModule({
      catalog: [
        { tsCode: '881101.TI', type: 'I' },
        { tsCode: '885311.TI', type: 'N' },
      ],
    });
    client.query.mockResolvedValueOnce([
      {
        ts_code: '881101.TI', trade_date: '20260512',
        open: 1, high: 1, low: 1, close: 1, pre_close: 1, change: 0, pct_change: 0,
        vol: 10, turnover_rate: 0, total_mv: 10000, float_mv: 10000,
      },
      {
        ts_code: '999999.XX', trade_date: '20260512',
        open: 9, high: 9, low: 9, close: 9, pre_close: 9, change: 0, pct_change: 0,
        vol: 90, turnover_rate: 0, total_mv: 90000, float_mv: 90000,
      },
    ]);

    const result = await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    expect(result.success).toBe(1);
    const [entities] = quotesRepo.upsert.mock.calls[0];
    expect(entities).toHaveLength(1);
    expect(entities[0].tsCode).toBe('881101.TI');
  });

  it('Tushare 调用异常 → push errors.apiName=ths_daily + message', async () => {
    const { service, client } = await buildModule({
      catalog: [{ tsCode: '881101.TI', type: 'I' }],
    });
    client.query.mockRejectedValue(new Error('boom'));

    const result = await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    expect(result.success).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].apiName).toBe('ths_daily');
    expect(result.errors[0].params).toEqual({ trade_date: '20260512' });
    expect(result.errors[0].message).toContain('boom');
  });
});
