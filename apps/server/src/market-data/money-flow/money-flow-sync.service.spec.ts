import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { getDataSourceToken } from '@nestjs/typeorm';
import { firstValueFrom, toArray } from 'rxjs';
import { MoneyFlowSyncService } from './money-flow-sync.service';
import { runWithRetry } from './money-flow-sync.helpers';
import { MoneyFlowStockEntity } from '../../entities/money-flow/money-flow-stock.entity';
import { MoneyFlowIndustryEntity } from '../../entities/money-flow/money-flow-industry.entity';
import { MoneyFlowSectorEntity } from '../../entities/money-flow/money-flow-sector.entity';
import { MoneyFlowMarketEntity } from '../../entities/money-flow/money-flow-market.entity';
import { ThsMemberStockEntity } from '../../entities/money-flow/ths-member-stock.entity';
import { AShareSymbolEntity } from '../../entities/a-share/a-share-symbol.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { IndexWeightSyncService } from '../index-weight/index-weight-sync.service';
import { MoneyFlowAggregationService } from './money-flow-aggregation.service';
import * as syncUtils from '../a-shares/sync/a-shares-sync-utils';

describe('MoneyFlowSyncService - SSE & retry', () => {
  let service: MoneyFlowSyncService;
  let tushareClient: { query: jest.Mock };
  const mockRepo = () => {
    const qb: any = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      delete: jest.fn().mockReturnThis(),
      execute: jest.fn().mockResolvedValue({}),
      getRawMany: jest.fn().mockResolvedValue([]),
      getMany: jest.fn().mockResolvedValue([]),
    };
    return {
      createQueryBuilder: jest.fn().mockReturnValue(qb),
      upsert: jest.fn().mockResolvedValue({}),
      create: jest.fn().mockImplementation((x: any) => x),
    };
  };
  const mockDataSource = {
    transaction: jest.fn().mockImplementation(async (cb: (m: any) => Promise<unknown>) => {
      return cb({
        delete: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
      });
    }),
  };

  beforeEach(async () => {
    tushareClient = { query: jest.fn() };
    jest.spyOn(syncUtils, 'resolveOpenTradeDates').mockResolvedValue(['20260501', '20260502']);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoneyFlowSyncService,
        { provide: getRepositoryToken(MoneyFlowStockEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowIndustryEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowSectorEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowMarketEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(AShareSymbolEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(ThsMemberStockEntity), useValue: mockRepo() },
        { provide: getDataSourceToken(), useValue: mockDataSource },
        { provide: TushareClientService, useValue: tushareClient },
        { provide: IndexWeightSyncService, useValue: { syncIfNeeded: jest.fn().mockResolvedValue({ totalIndexes: 0, successIndexes: 0, errors: [], changedIndexes: [] }) } },
        { provide: MoneyFlowAggregationService, useValue: { aggregateAll: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();

    service = module.get(MoneyFlowSyncService);
  });

  afterEach(() => {
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  it('runWithRetry: 第二次成功 → 累计 1 条 retry 事件 + 不抛异常', async () => {
    jest.useFakeTimers();
    tushareClient.query
      .mockRejectedValueOnce(new Error('limit'))
      .mockResolvedValueOnce([]);
    const events: any[] = [];
    const promise = runWithRetry(
      () => tushareClient.query('x', {}, ''),
      (attempt: number, err: unknown) => events.push({ attempt, err: String(err) }),
    );
    await jest.advanceTimersByTimeAsync(1000);
    await expect(promise).resolves.toEqual([]);
    expect(events).toHaveLength(1);
    expect(events[0].attempt).toBe(1);
  });

  it('runWithRetry: 连续 3 次失败 → 抛出最后一次错误', async () => {
    jest.useFakeTimers();
    tushareClient.query
      .mockRejectedValue(new Error('limit'));
    const events: any[] = [];
    const promise = runWithRetry(
      () => tushareClient.query('x', {}, ''),
      (attempt: number, err: unknown) => events.push({ attempt, err: String(err) }),
    ).catch((e: Error) => e);
    await jest.advanceTimersByTimeAsync(3000);
    const err = await promise;
    expect(err).toBeInstanceOf(Error);
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.attempt)).toEqual([1, 2]);
  });

  it.skip('startSync: 聚合模式下 syncStocks 失败会 emit error 事件（TODO: 任务 25 重写测试）', async () => {
    jest.useFakeTimers();
    jest.spyOn(syncUtils, 'resolveOpenTradeDates').mockResolvedValue(['20260501']);
    tushareClient.query.mockRejectedValue(new Error('boom'));

    const subject = (service as any).startSync({ start_date: '20260501', end_date: '20260501', syncMode: 'overwrite' });
    const eventsPromise = firstValueFrom(subject.pipe(toArray())) as Promise<any[]>;
    await jest.advanceTimersByTimeAsync(20000);
    const events: any[] = await eventsPromise;

    const errorEvent = events.find((e: any) => e.type === 'error') as any;
    expect(errorEvent).toBeDefined();
    expect(errorEvent.message).toContain('boom');
  });
});
