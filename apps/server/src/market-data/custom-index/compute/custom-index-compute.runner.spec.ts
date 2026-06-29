import { Test, TestingModule } from '@nestjs/testing';
import { getDataSourceToken, getRepositoryToken } from '@nestjs/typeorm';
import { CustomIndexAmvEntity } from '../../../entities/custom-index/custom-index-amv.entity';
import { CustomIndexDefinitionEntity } from '../../../entities/custom-index/custom-index-definition.entity';
import { CustomIndexMoneyFlowEntity } from '../../../entities/custom-index/custom-index-money-flow.entity';
import { CustomIndexComputeRunner } from './custom-index-compute.runner';
import { CustomIndexIndicatorService } from './custom-index-indicator.service';
import { CustomIndexMoneyFlowService } from './custom-index-money-flow.service';
import { CustomIndexQuotesWriter } from './custom-index-quotes-writer';
import * as contextLoader from './custom-index-compute-context.loader';
import * as priceIndex from './custom-index-price-index';
import * as weightResolver from './custom-index-weight-resolver';

describe('CustomIndexComputeRunner', () => {
  let runner: CustomIndexComputeRunner;
  let definitionRepo: { findOne: jest.Mock; update: jest.Mock };
  let dataSource: { query: jest.Mock };
  let quotesWriter: { upsertQuotes: jest.Mock };
  let indicatorService: { upsertIndicatorsFromQuotes: jest.Mock };
  let moneyFlowService: { aggregateMoneyFlow: jest.Mock };

  const customIndexId = 'idx-runner-1';
  const userId = 'user-a';

  const baseDef: CustomIndexDefinitionEntity = {
    id: customIndexId,
    userId,
    tsCode: 'CUST.deadbeef.U',
    name: 'Runner 测试',
    description: null,
    indexType: 'price',
    baseDate: '20200102',
    basePoint: '1000',
    weightMethod: 'equal',
    status: 'pending',
    computeProgress: 0,
    computeStage: null,
    latestJobId: null,
    lastError: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  const versions = [
    {
      id: 1,
      effectiveDate: '20200102',
      expireDate: null,
      weightMethod: 'equal',
      members: [
        { conCode: '600519.SH', weight: 0.5 },
        { conCode: '000858.SZ', weight: 0.5 },
      ],
    },
  ];

  const sampleQuotes = [
    {
      tradeDate: '20200102',
      open: 1000,
      high: 1010,
      low: 990,
      close: 1000,
      preClose: 1000,
      change: 0,
      pctChange: 0,
      volHand: 100,
      amount: 1000,
    },
    {
      tradeDate: '20200103',
      open: 1005,
      high: 1015,
      low: 995,
      close: 1010,
      preClose: 1000,
      change: 10,
      pctChange: 1,
      volHand: 120,
      amount: 1200,
    },
  ];

  beforeEach(async () => {
    definitionRepo = {
      findOne: jest.fn().mockResolvedValue({ ...baseDef }),
      update: jest.fn().mockResolvedValue(undefined),
    };
    dataSource = {
      query: jest.fn().mockResolvedValue(undefined),
    };
    quotesWriter = {
      upsertQuotes: jest.fn().mockResolvedValue(1),
    };
    indicatorService = {
      upsertIndicatorsFromQuotes: jest.fn().mockResolvedValue(2),
    };
    moneyFlowService = {
      aggregateMoneyFlow: jest.fn().mockResolvedValue([
        {
          customIndexId,
          tradeDate: '20200102',
          netAmount: 1,
          buyLgAmount: 2,
          buyMdAmount: 3,
          buySmAmount: 4,
        },
      ]),
    };

    jest.spyOn(weightResolver, 'loadWeightVersions').mockResolvedValue(versions);
    jest.spyOn(weightResolver, 'validateVersions').mockImplementation(() => undefined);
    jest.spyOn(contextLoader, 'loadComputeContext').mockResolvedValue({
      tradeDates: ['20200102', '20200103'],
      barsByDate: {},
      stockMeta: {},
      adjLatest: {},
      warnings: [],
    });
    jest.spyOn(priceIndex, 'computePriceIndexQuotes').mockReturnValue(sampleQuotes);

    const module: TestingModule = await Test.createTestingModule({
      providers: [
        CustomIndexComputeRunner,
        { provide: getDataSourceToken(), useValue: dataSource },
        {
          provide: getRepositoryToken(CustomIndexDefinitionEntity),
          useValue: definitionRepo,
        },
        {
          provide: getRepositoryToken(CustomIndexMoneyFlowEntity),
          useValue: { create: jest.fn((x) => x), upsert: jest.fn().mockResolvedValue(undefined) },
        },
        {
          provide: getRepositoryToken(CustomIndexAmvEntity),
          useValue: { create: jest.fn((x) => x), upsert: jest.fn().mockResolvedValue(undefined) },
        },
        { provide: CustomIndexQuotesWriter, useValue: quotesWriter },
        { provide: CustomIndexIndicatorService, useValue: indicatorService },
        { provide: CustomIndexMoneyFlowService, useValue: moneyFlowService },
      ],
    }).compile();

    runner = module.get(CustomIndexComputeRunner);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('Stage 1–7 更新 progress/stage 并最终 ready', async () => {
    runner.tryAcquire(customIndexId);
    await runner.run({ customIndexId, userId, fullRebuild: true });

    const updates = definitionRepo.update.mock.calls.map(([, patch]) => patch);
    expect(updates.some((p) => p.computeStage === 'load_members' && p.status === 'computing')).toBe(
      true,
    );
    expect(updates.some((p) => p.computeStage === 'sync_quotes')).toBe(true);
    expect(updates.some((p) => p.computeStage === 'quotes')).toBe(true);
    expect(updates.some((p) => p.computeStage === 'indicators')).toBe(true);
    expect(updates.some((p) => p.computeStage === 'money_flow')).toBe(true);
    expect(updates.some((p) => p.computeStage === 'amv')).toBe(true);
    expect(updates.some((p) => p.status === 'ready' && p.computeProgress === 100)).toBe(true);

    expect(dataSource.query).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM custom_index_daily_quotes'),
      [customIndexId],
    );
    expect(quotesWriter.upsertQuotes).toHaveBeenCalled();
    expect(indicatorService.upsertIndicatorsFromQuotes).toHaveBeenCalledWith(
      customIndexId,
      sampleQuotes,
    );
  });

  it('已在 computing 时拒绝重复 run', async () => {
    definitionRepo.findOne.mockResolvedValue({ ...baseDef, status: 'computing' });
    runner.tryAcquire(customIndexId);
    await runner.run({ customIndexId, userId });
    expect(definitionRepo.update).not.toHaveBeenCalled();
    runner.release(customIndexId);
  });

  it('失败时写 status=failed + last_error', async () => {
    jest.spyOn(contextLoader, 'loadComputeContext').mockRejectedValue(new Error('load failed'));
    runner.tryAcquire(customIndexId);

    await expect(runner.run({ customIndexId, userId })).rejects.toThrow('load failed');

    expect(definitionRepo.update).toHaveBeenCalledWith(
      { id: customIndexId },
      expect.objectContaining({
        status: 'failed',
        lastError: 'load failed',
      }),
    );
  });

  it('计算产出 0 点位：显式失败而非伪装 ready', async () => {
    jest.spyOn(priceIndex, 'computePriceIndexQuotes').mockReturnValue([]);
    runner.tryAcquire(customIndexId);

    await expect(runner.run({ customIndexId, userId })).rejects.toThrow(/0 个点位/);

    // 0 点位不得 upsert、不得标 ready；应落 failed + lastError
    expect(quotesWriter.upsertQuotes).not.toHaveBeenCalled();
    const updates = definitionRepo.update.mock.calls.map(([, patch]) => patch);
    expect(updates.some((p) => p.status === 'ready')).toBe(false);
    expect(
      updates.some((p) => p.status === 'failed' && /0 个点位/.test(String(p.lastError))),
    ).toBe(true);
  });
});
