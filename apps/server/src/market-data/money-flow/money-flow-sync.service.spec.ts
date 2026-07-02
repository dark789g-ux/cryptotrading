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
import { DailyQuoteEntity } from '../../entities/raw/daily-quote.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import { IndexWeightSyncService } from '../index-weight/index-weight-sync.service';
import { MoneyFlowAggregationService } from './money-flow-aggregation.service';
import * as syncUtils from '../a-shares/sync/a-shares-sync-utils';

describe('MoneyFlowSyncService - SSE & retry', () => {
  let service: MoneyFlowSyncService;
  let tushareClient: { query: jest.Mock };
  let dailyQuoteRepo: { query: jest.Mock };
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
    dailyQuoteRepo = { query: jest.fn() };
    jest.spyOn(syncUtils, 'resolveOpenTradeDates').mockResolvedValue(['20260501', '20260502']);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoneyFlowSyncService,
        { provide: getRepositoryToken(MoneyFlowStockEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowIndustryEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowSectorEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowMarketEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(AShareSymbolEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(DailyQuoteEntity), useValue: dailyQuoteRepo },
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

// ── POST-sync 完整性对账（syncStocks） ─────────────────────────────────────

describe('MoneyFlowSyncService - syncStocks POST-sync 对账', () => {
  let service: MoneyFlowSyncService;
  let tushareClient: { query: jest.Mock };
  let dailyQuoteRepo: { query: jest.Mock };

  /** 喂一行 moneyflow_ths 数据（Tushare shape）。 */
  function mfRow(tsCode: string, tradeDate: string) {
    return {
      trade_date: tradeDate,
      ts_code: tsCode,
      name: '示例',
      pct_change: '1.5',
      latest: '10.0',
      net_amount: '100',
      net_d5_amount: '500',
      buy_lg_amount: '50',
      buy_lg_amount_rate: '0.5',
      buy_md_amount: '30',
      buy_md_amount_rate: '0.3',
      buy_sm_amount: '20',
      buy_sm_amount_rate: '0.2',
    };
  }

  /**
   * 按本组测试需要，预置 dailyQuoteRepo.query 的 SQL 感知 mock：
   *   - target SQL（FROM public.money_flow_stocks）→ targetRows
   *   - baseline SQL（FROM raw.daily_quote）→ baselineRows
   */
  function seedCompletenessQuery(
    targetRows: Array<{ trade_date: string; total: string }>,
    baselineRows: Array<{ trade_date: string; total: string }>,
  ) {
    dailyQuoteRepo.query.mockImplementation((sql: string) => {
      if (sql.includes('FROM public.money_flow_stocks')) return Promise.resolve(targetRows);
      if (sql.includes('FROM raw.daily_quote')) return Promise.resolve(baselineRows);
      return Promise.resolve([]);
    });
  }

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

  beforeEach(async () => {
    tushareClient = { query: jest.fn() };
    dailyQuoteRepo = { query: jest.fn() };
    jest.spyOn(syncUtils, 'resolveOpenTradeDates').mockResolvedValue(['20260501']);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        MoneyFlowSyncService,
        { provide: getRepositoryToken(MoneyFlowStockEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowIndustryEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowSectorEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(MoneyFlowMarketEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(AShareSymbolEntity), useValue: mockRepo() },
        { provide: getRepositoryToken(DailyQuoteEntity), useValue: dailyQuoteRepo },
        { provide: getRepositoryToken(ThsMemberStockEntity), useValue: mockRepo() },
        { provide: getDataSourceToken(), useValue: {} },
        { provide: TushareClientService, useValue: tushareClient },
        { provide: IndexWeightSyncService, useValue: { syncIfNeeded: jest.fn().mockResolvedValue({ totalIndexes: 0, successIndexes: 0, errors: [], changedIndexes: [] }) } },
        { provide: MoneyFlowAggregationService, useValue: { aggregateAll: jest.fn().mockResolvedValue([]) } },
      ],
    }).compile();
    service = module.get(MoneyFlowSyncService);
  });

  afterEach(() => jest.restoreAllMocks());

  it('actual < baseline → errors 含 moneyflow_ths_incomplete（携带 apiName + 日期 + 行数）', async () => {
    // moneyflow_ths 返回 100 行；daily_quote 当日应有 200 行 → 残缺
    tushareClient.query.mockResolvedValueOnce([mfRow('000001.SZ', '20260501')]);
    // 用 100 行（mock 成 100 条）— 简化为 1 行即可，对账看的是入库后的 SQL COUNT
    seedCompletenessQuery(
      [{ trade_date: '20260501', total: '100' }], // target: money_flow_stocks
      [{ trade_date: '20260501', total: '200' }], // baseline: daily_quote
    );

    const result = await service.syncStocks({ start_date: '20260501', end_date: '20260501', syncMode: 'overwrite' });

    const incompletes = result.errors.filter((e: string) => e.includes('moneyflow_ths_incomplete'));
    expect(incompletes).toHaveLength(1);
    expect(incompletes[0]).toContain('20260501');
    expect(incompletes[0]).toContain('100 < 200');
  });

  it('基准当日未落库（daily_quote GROUP BY 返回空）→ 不告警', async () => {
    tushareClient.query.mockResolvedValueOnce([mfRow('000001.SZ', '20260501')]);
    seedCompletenessQuery(
      [{ trade_date: '20260501', total: '100' }],
      [], // baseline 当日未落库 → 跳过
    );

    const result = await service.syncStocks({ start_date: '20260501', end_date: '20260501', syncMode: 'overwrite' });

    expect(result.errors.filter((e: string) => e.includes('moneyflow_ths_incomplete'))).toEqual([]);
  });

  it('actual == baseline（完整）→ 不告警', async () => {
    tushareClient.query.mockResolvedValueOnce([mfRow('000001.SZ', '20260501')]);
    seedCompletenessQuery(
      [{ trade_date: '20260501', total: '200' }],
      [{ trade_date: '20260501', total: '200' }],
    );

    const result = await service.syncStocks({ start_date: '20260501', end_date: '20260501', syncMode: 'overwrite' });

    expect(result.errors.filter((e: string) => e.includes('moneyflow_ths_incomplete'))).toEqual([]);
  });

  // ── 基准收窄修复（moneyflow_ths 不覆盖北交所 .BJ 与退市股）──────────────

  it('baseline SQL 含北交所 / 退市股过滤片段（config filter 已拼入 WHERE）', async () => {
    tushareClient.query.mockResolvedValueOnce([mfRow('000001.SZ', '20260501')]);
    seedCompletenessQuery(
      [{ trade_date: '20260501', total: '5190' }],
      [{ trade_date: '20260501', total: '5190' }],
    );

    await service.syncStocks({ start_date: '20260501', end_date: '20260501', syncMode: 'overwrite' });

    // 找到 baseline 查询（FROM raw.daily_quote），断言 filter 三段都已拼入 SQL。
    // 这是对「基准收窄」最直接的回归保护——删掉 filter 会立即被这条断言抓住。
    const baselineCall = dailyQuoteRepo.query.mock.calls.find(
      ([sql]: unknown[]) => typeof sql === 'string' && (sql as string).includes('FROM raw.daily_quote'),
    );
    expect(baselineCall).toBeDefined();
    const sql = baselineCall![0] as string;
    expect(sql).toContain('vol > 0');
    expect(sql).toContain("ts_code NOT LIKE '%.BJ'");
    expect(sql).toContain("name LIKE '%退%'"); // 退市股子查询
    expect(sql).toContain('a_share_symbols'); // 子查询表名
  });

  it('北交所 / 退市股在 daily_quote 全量但不在 money_flow_stocks → 基准已收窄不误报', async () => {
    // 语义：raw.daily_quote 全量 5517 行（含 327 北交所 + 退市），基准 filter 收窄后 = 5190；
    // money_flow_stocks 入库 5190（沪深非退市，与数据源覆盖一致）= 收窄后基准 → 不告警。
    // 真实场景由 DB SQL filter 实现（上一条用例断言），此处验证对账逻辑据「收窄后基准」判完整。
    tushareClient.query.mockResolvedValueOnce([mfRow('000001.SZ', '20260501')]);
    seedCompletenessQuery(
      [{ trade_date: '20260501', total: '5190' }], // target: 入库沪深非退市
      [{ trade_date: '20260501', total: '5190' }], // baseline: daily_quote 收窄后
    );

    const result = await service.syncStocks({ start_date: '20260501', end_date: '20260501', syncMode: 'overwrite' });

    expect(result.errors.filter((e: string) => e.includes('moneyflow_ths_incomplete'))).toEqual([]);
  });
});
