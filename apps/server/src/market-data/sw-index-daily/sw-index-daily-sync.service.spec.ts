// TODO: 需集成测试验证 API 契约 —— 本文件 mock 了 TushareClientService.query，
// 无法发现 sw_daily / index_classify 真实接口名、字段名、单位变更。集成测试应覆盖：
//   1) sw_daily 真实响应 fields 顺序与 vol/amount/total_mv/float_mv 单位（万股/万元）
//   2) index_classify 三级（L1/L2/L3 + src=SW2021）真实 parent_code 树结构
//   3) trade_cal 真实交易日序列
import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { SwIndexDailySyncService } from './sw-index-daily-sync.service';
import { ThsIndexDailyIndicatorService } from '../ths-index-daily/ths-index-daily-indicator.service';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { SwIndexCatalogEntity } from '../../entities/sw-index/sw-index-catalog.entity';
import { TushareClientService } from '../a-shares/services/tushare-client.service';
import * as syncUtils from '../a-shares/sync/a-shares-sync-utils';

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
    getRawMany: jest.fn().mockResolvedValue([]),
  };
  return {
    createQueryBuilder: jest.fn().mockReturnValue(qb),
    upsert: jest.fn().mockResolvedValue({}),
    // create 直接透传（与 ths spec 同款），让断言能读到 map 后的字段
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
  };
}

function makeCatalogRepo(): MockRepo {
  return {
    createQueryBuilder: jest.fn(),
    upsert: jest.fn().mockResolvedValue({}),
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
  };
}

async function buildModule(opts: {
  indicatorService?: Partial<ThsIndexDailyIndicatorService>;
} = {}): Promise<{
  service: SwIndexDailySyncService;
  client: { query: jest.Mock };
  quotesRepo: MockRepo;
  catalogRepo: MockRepo;
}> {
  const client = { query: jest.fn() };
  const quotesRepo = makeQuotesRepo();
  const catalogRepo = makeCatalogRepo();

  const module: TestingModule = await Test.createTestingModule({
    providers: [
      SwIndexDailySyncService,
      { provide: getRepositoryToken(IndexDailyQuoteEntity), useValue: quotesRepo },
      { provide: getRepositoryToken(SwIndexCatalogEntity), useValue: catalogRepo },
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

  return {
    service: module.get(SwIndexDailySyncService),
    client,
    quotesRepo,
    catalogRepo,
  };
}

describe('SwIndexDailySyncService', () => {
  beforeEach(() => {
    jest.spyOn(syncUtils, 'resolveOpenTradeDates').mockResolvedValue(['20260512']);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('单位换算：vol 万股×100→手、amount 万元×10→千元、total_mv/float_mv 万元一致、pe/pb 直填', async () => {
    const { service, client, quotesRepo } = await buildModule();
    // index_classify 三级均返回空（目录灌入不影响行情断言）
    client.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    client.query.mockResolvedValueOnce([
      {
        ts_code: '801010.SI',
        trade_date: '20260512',
        name: '农林牧渔',
        open: 1000.5,
        high: 1020.0,
        low: 990.0,
        close: 1010.0,
        change: 10.0,
        pct_change: 1.0,
        vol: 12345.67, // 万股
        amount: 98765.4, // 万元
        pe: 28.32,
        pb: 2.66,
        total_mv: 1_234_567, // 万元（文档冻结：total_mv 单位=万元，与库列一致，不换算）
        float_mv: 835_320, // 万元
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
    expect(entity.tsCode).toBe('801010.SI');
    expect(entity.category).toBe('sw');
    expect(entity.volHand).toBeCloseTo(12345.67 * 100); // 万股 → 手
    expect(entity.amount).toBeCloseTo(98765.4 * 10); // 万元 → 千元
    expect(entity.pe).toBeCloseTo(28.32);
    expect(entity.pb).toBeCloseTo(2.66);
    expect(entity.totalMvWan).toBe(String(1_234_567)); // 万元一致
    expect(entity.floatMvWan).toBe(String(835_320));
    expect(entity.preClose).toBeNull(); // sw_daily 无 pre_close
    expect(entity.turnoverRate).toBeNull(); // sw 无换手率
  });

  it('空数据：返回 0 行时显式推送 failedItem: sw_daily_empty + params', async () => {
    const { service, client } = await buildModule();
    client.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    client.query.mockResolvedValueOnce([]);

    const result = await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    expect(result.success).toBe(0);
    expect(result.errors).toEqual([
      { apiName: 'sw_daily_empty', params: { trade_date: '20260512' } },
    ]);
  });

  it('重复 (ts_code, trade_date) 去重保留最后一条 + warn 原始/去重条数', async () => {
    const { service, client, quotesRepo } = await buildModule();
    client.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    client.query.mockResolvedValueOnce([
      {
        ts_code: '801010.SI', trade_date: '20260512',
        open: 1, high: 1, low: 1, close: 1, change: 0, pct_change: 0,
        vol: 10, amount: 10, pe: 1, pb: 1, total_mv: 10000, float_mv: 10000,
      },
      {
        ts_code: '801010.SI', trade_date: '20260512',
        open: 2, high: 2, low: 2, close: 2, change: 0, pct_change: 0,
        vol: 20, amount: 20, pe: 2, pb: 2, total_mv: 20000, float_mv: 20000,
      },
    ]);
    // 抑制 catalog 灌入日志噪音
    const { Logger } = await import('@nestjs/common');
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);

    const result = await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    expect(result.success).toBe(1);
    const [entities] = quotesRepo.upsert.mock.calls[0];
    expect(entities).toHaveLength(1);
    expect(entities[0].open).toBe(2); // 保留最后一条
  });

  it('Tushare sw_daily 调用异常 → push errors.apiName=sw_daily + message（不静默吞错）', async () => {
    const { service, client } = await buildModule();
    // index_classify 三级成功
    client.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    client.query.mockRejectedValue(new Error('boom'));

    const result = await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    expect(result.success).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0].apiName).toBe('sw_daily');
    expect(result.errors[0].params).toEqual({ trade_date: '20260512' });
    expect(result.errors[0].message).toContain('boom');
  });

  it('index_classify 三级灌入：用 src=SW2021 + level=L1/L2/L3 拉取（非 market=SW）', async () => {
    const { service, client } = await buildModule();
    client.query.mockResolvedValueOnce([]).mockResolvedValueOnce([]).mockResolvedValueOnce([]);
    client.query.mockResolvedValueOnce([
      {
        ts_code: '801010.SI', trade_date: '20260512',
        open: 1, high: 1, low: 1, close: 1, change: 0, pct_change: 0,
        vol: 10, amount: 10, pe: 1, pb: 1, total_mv: 10000, float_mv: 10000,
      },
    ]);

    await service.sync({
      start_date: '20260512',
      end_date: '20260512',
      syncMode: 'overwrite',
    });

    // 前 3 次调用是 index_classify，验证入参用的是 src+level（非 market）
    const classifyCalls = client.query.mock.calls.slice(0, 3);
    for (const call of classifyCalls) {
      expect(call[0]).toBe('index_classify');
      const params = call[1];
      expect(params.src).toBe('SW2021');
      expect(params.level).toMatch(/^L[123]$/);
      expect(params).not.toHaveProperty('market');
    }
    const levels = classifyCalls.map((c) => c[1].level);
    expect(levels.sort()).toEqual(['L1', 'L2', 'L3']);
  });
});
