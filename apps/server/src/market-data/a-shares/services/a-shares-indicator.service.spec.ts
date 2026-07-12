import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ASharesIndicatorService } from './a-shares-indicator.service';
import { DailyIndicatorEntity } from '../../../entities/raw/daily-indicator.entity';
import { IndicatorCalcStateEntity } from '../../../entities/raw/indicator-calc-state.entity';
import { IndicatorCalcState } from '../../../indicators/indicators-stream';

function makeQuotes(n: number, startClose = 10, amount = 1000) {
  return Array.from({ length: n }, (_, i) => ({
    tsCode: '000001.SZ',
    tradeDate: `202606${String(i + 1).padStart(2, '0')}`,
    qfqOpen: startClose + i,
    qfqHigh: startClose + i + 1,
    qfqLow: startClose + i - 0.5,
    qfqClose: startClose + i + 0.5,
    vol: 10000,
    amount,
  }));
}

function fakeRepos() {
  return {
    create: jest.fn().mockImplementation((x: Record<string, unknown>) => x),
    upsert: jest.fn().mockResolvedValue({}),
    insert: jest.fn().mockResolvedValue({}),
  };
}

function fakeDataSource() {
  return {
    query: jest.fn().mockResolvedValue([]),
  };
}

function makeSeedState(overrides?: Partial<IndicatorCalcState>): IndicatorCalcState {
  return {
    count: 100,
    ema12: 11.5,
    ema26: 12.3,
    dea: 0.5,
    kdjK: 50,
    kdjD: 50,
    atr14: 1.2,
    closes: Array.from({ length: 100 }, (_, i) => 10 + i * 0.5),
    highs: Array.from({ length: 8 }, (_, i) => 15 + i),
    lows: Array.from({ length: 8 }, (_, i) => 8 + i),
    qvols: Array.from({ length: 9 }, () => 1000),
    trs: Array.from({ length: 13 }, () => 1.5),
    signedAmounts: Array.from({ length: 20 }, () => 1000),
    amounts: Array.from({ length: 20 }, () => 1000),
    qfqVols: Array.from({ length: 20 }, () => 1000),
    brickSma2a: 10,
    brickSma4a: 10,
    brickSma5a: 10,
    brickPrev1: 10,
    brickPrev2: 10,
    brickInited: true,
    ...overrides,
  };
}

describe('ASharesIndicatorService', () => {
  let service: ASharesIndicatorService;
  let dataSource: { query: jest.Mock };

  async function createService() {
    const module: TestingModule = await Test.createTestingModule({
      providers: [
        ASharesIndicatorService,
        { provide: getRepositoryToken(DailyIndicatorEntity), useValue: fakeRepos() },
        { provide: getRepositoryToken(IndicatorCalcStateEntity), useValue: fakeRepos() },
        { provide: DataSource, useValue: fakeDataSource() },
      ],
    }).compile();
    module.useLogger(false);
    service = module.get(ASharesIndicatorService);
    dataSource = module.get(DataSource) as unknown as { query: jest.Mock };
  }

  beforeEach(async () => {
    await createService();
  });

  it('seed 缺 signedAmounts → 触发 repair（loadQuoteRowsBefore）→ 续算', async () => {
    const tsCode = '000001.SZ';
    const seedState = makeSeedState({ signedAmounts: [] as unknown as number[] });
    const historyQuotes = makeQuotes(21, 8, 1000);
    const dirtyQuotes = makeQuotes(1, 100, 1000);
    dirtyQuotes[0].tradeDate = '20260706';

    dataSource.query
      .mockResolvedValueOnce([{ dirtyFrom: '20260706' }])
      .mockResolvedValueOnce([{ minDate: '20200101' }])
      .mockResolvedValueOnce([{ tradeDate: '20260630', state: seedState }])
      .mockResolvedValueOnce([...historyQuotes].reverse())
      .mockResolvedValueOnce(dirtyQuotes)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const written = await service.recalculateDirtyIndicatorsForSymbols([tsCode]);

    expect(written).toBe(1);

    const descCall = dataSource.query.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('ORDER BY trade_date DESC') && (c[0] as string).includes('LIMIT $3'),
    );
    expect(descCall).toBeDefined();

    const upsertCall = (service as unknown as Record<string, { upsert?: { mock: { calls: unknown[][] } } }>).indicatorRepo?.upsert;
    if (upsertCall) {
      const [persisted] = upsertCall.mock.calls[0];
      expect(persisted).toHaveLength(1);
      expect(persisted[0].obv5d).not.toBeNull();
    }
  });

  it('seed 含充足 signedAmounts（>=19）→ 不触发 repair', async () => {
    const tsCode = '000001.SZ';
    const seedState = makeSeedState();
    const dirtyQuotes = makeQuotes(1, 100, 1000);
    dirtyQuotes[0].tradeDate = '20260706';

    dataSource.query
      .mockResolvedValueOnce([{ dirtyFrom: '20260706' }])
      .mockResolvedValueOnce([{ minDate: '20200101' }])
      .mockResolvedValueOnce([{ tradeDate: '20260630', state: seedState }])
      .mockResolvedValueOnce(dirtyQuotes)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);

    const written = await service.recalculateDirtyIndicatorsForSymbols([tsCode]);

    expect(written).toBe(1);

    const descCall = dataSource.query.mock.calls.find((c: unknown[]) =>
      (c[0] as string).includes('ORDER BY trade_date DESC') && (c[0] as string).includes('LIMIT $3'),
    );
    expect(descCall).toBeUndefined();
  });
});
