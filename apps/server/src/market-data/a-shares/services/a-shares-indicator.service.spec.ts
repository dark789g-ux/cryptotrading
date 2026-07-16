import { Test, TestingModule } from '@nestjs/testing';
import { getRepositoryToken } from '@nestjs/typeorm';
import { DataSource } from 'typeorm';
import { ASharesIndicatorService } from './a-shares-indicator.service';
import { DailyIndicatorEntity } from '../../../entities/raw/daily-indicator.entity';
import { IndicatorCalcStateEntity } from '../../../entities/raw/indicator-calc-state.entity';
import { IndicatorCalcState } from '../../../indicators/indicators-stream';
import { calcIndicators } from '../../../indicators/indicators';
import { calcIndicatorsStreaming } from '../../../indicators/indicators-stream';

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

describe('recalculateIndicatorsForSymbol 全量重算', () => {
  let service: ASharesIndicatorService;
  let dataSource: { query: jest.Mock };
  let indicatorRepo: ReturnType<typeof fakeRepos>;
  let calcStateRepo: ReturnType<typeof fakeRepos>;

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
    indicatorRepo = module.get(getRepositoryToken(DailyIndicatorEntity)) as unknown as ReturnType<typeof fakeRepos>;
    calcStateRepo = module.get(getRepositoryToken(IndicatorCalcStateEntity)) as unknown as ReturnType<typeof fakeRepos>;
  }

  beforeEach(async () => {
    await createService();
  });

  it('全量重算：MA 基于前复权价 qfqClose（300 根可算 MA240）', async () => {
    const tsCode = '000001.SZ';
    // 造 300 根数据，qfqClose 为特定递增序列
    const n = 300;
    const quotes = Array.from({ length: n }, (_, i) => ({
      tsCode,
      tradeDate: `2025${String(Math.floor(i / 28) + 1).padStart(2, '0')}${String((i % 28) + 1).padStart(2, '0')}`,
      qfqOpen: 10 + i * 0.5,
      qfqHigh: 10 + i * 0.5 + 1,
      qfqLow: 10 + i * 0.5 - 0.5,
      qfqClose: 10 + i * 0.5,
      vol: 10000,
      amount: 1000,
    }));

    // mock dataSource.query：
    // 第 1 次调用：loadQuoteRows（SELECT ... ORDER BY trade_date ASC）
    // 第 2 次调用：sync_states INSERT（不需要返回值）
    // MA60 最后 60 根均值：(10+240*0.5 + ... + 10+299*0.5) / 60 = 144.75
    // MA240 最后 240 根均值：(10+60*0.5 + ... + 10+299*0.5) / 240 = 99.75
    const sampleStoredMa60 = 144.75;
    const sampleStoredMa240 = 99.75;
    dataSource.query
      .mockResolvedValueOnce(quotes)   // loadQuoteRows
      .mockResolvedValueOnce([])       // sync_states INSERT
      .mockResolvedValueOnce([          // verifyIndicatorSample
        {
          stored_ma60: sampleStoredMa60,
          stored_ma240: sampleStoredMa240,
          recompute_ma60: sampleStoredMa60,   // 相等 → 偏差 0%，不 warn
          recompute_ma240: sampleStoredMa240,
        },
      ]);

    // 通过 recalculateIndicatorsForSymbols 间接调用（private 方法）
    const written = await service.recalculateIndicatorsForSymbols([tsCode]);
    expect(written).toBe(n);

    // 用 calcIndicators 对同一份 qfqClose 数据算期望值
    const klineRows = quotes.map((q) => ({
      open_time: q.tradeDate,
      open: q.qfqOpen,
      high: q.qfqHigh,
      low: q.qfqLow,
      close: q.qfqClose,   // service 里 close: row.qfqClose
      volume: q.vol,
      quote_volume: q.amount,
      qfqClose: q.qfqClose,
    }));
    const expected = calcIndicators(klineRows);

    // 从 indicatorRepo.upsert 的调用中捕获写入的 entity
    // upsertInChunks 会去重后分片调用 repo.upsert
    expect(indicatorRepo.upsert).toHaveBeenCalled();
    const upsertCalls = indicatorRepo.upsert.mock.calls;
    // 收集所有 upsert 传入的 entities
    const allEntities: Record<string, unknown>[] = [];
    for (const call of upsertCalls) {
      // call[0] 是 entities 数组
      if (Array.isArray(call[0])) {
        allEntities.push(...call[0]);
      }
    }
    expect(allEntities.length).toBe(n);

    // 断言末位的 MA 值等于 calcIndicators 的期望值
    const lastEntity = allEntities[allEntities.length - 1];
    const lastExpected = expected[expected.length - 1];

    // MA240 满窗口后非空
    expect(lastExpected.MA240).not.toBeNull();
    expect(lastEntity.ma240).not.toBeNull();
    expect(lastEntity.ma240).toBeCloseTo(lastExpected.MA240 as number, 4);

    // MA60 也对拍
    expect(lastEntity.ma60).toBeCloseTo(lastExpected.MA60 as number, 4);

    // MA5 手算验证：末位 qfqClose = 10 + 299*0.5 = 159.5
    // MA5[299] = (159.5 + 159 + 158.5 + 158 + 157.5) / 5 = 158.5
    expect(lastEntity.ma5).toBeCloseTo(158.5, 4);
  });

  it('全量重算后重建 seed：indicator_calc_state 写入干净 closes（基于 qfqClose）', async () => {
    const tsCode = '000001.SZ';
    // 造 300 根数据，qfqClose 含除权跳变特征
    const n = 300;
    const quotes = Array.from({ length: n }, (_, i) => ({
      tsCode,
      tradeDate: `2025${String(Math.floor(i / 28) + 1).padStart(2, '0')}${String((i % 28) + 1).padStart(2, '0')}`,
      qfqOpen: 10 + i * 0.5,
      qfqHigh: 10 + i * 0.5 + 1,
      qfqLow: 10 + i * 0.5 - 0.5,
      qfqClose: 10 + i * 0.5,
      vol: 10000,
      amount: 1000,
    }));

    // mock dataSource.query 顺序：
    // 1: loadQuoteRows → quotes
    // 2: sync_states INSERT → []
    // 3: DELETE indicator_calc_state → []
    // 4: verifyIndicatorSample → [{ stored/recompute 相等 }]
    dataSource.query
      .mockResolvedValueOnce(quotes)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        stored_ma60: 144.75,
        stored_ma240: 99.75,
        recompute_ma60: 144.75,
        recompute_ma240: 99.75,
      }]);

    await service.recalculateIndicatorsForSymbols([tsCode]);

    // calcStateRepo.upsert 被调用
    expect(calcStateRepo.upsert).toHaveBeenCalled();
    const upsertCalls = calcStateRepo.upsert.mock.calls;

    // 收集所有 upsert 传入的 state entities
    const allStateEntities: Record<string, unknown>[] = [];
    for (const call of upsertCalls) {
      if (Array.isArray(call[0])) {
        allStateEntities.push(...call[0]);
      }
    }

    // createSparseCalcStateEntities 写最后 2 天，所以 entity 数量 = 2
    expect(allStateEntities.length).toBe(2);

    // 独立跑 streaming 取最后 2 个 state
    const klineRows = quotes.map((q) => ({
      open_time: q.tradeDate,
      open: q.qfqOpen,
      high: q.qfqHigh,
      low: q.qfqLow,
      close: q.qfqClose,
      volume: q.vol,
      quote_volume: q.amount,
      qfqClose: q.qfqClose,
    }));
    const streamingResult = calcIndicatorsStreaming(klineRows, null);
    const lastState = streamingResult[streamingResult.length - 1].state;
    const secondLastState = streamingResult[streamingResult.length - 2].state;

    // state.closes 末尾值 = 最后一天的 qfqClose（不是 raw close）
    const lastQfqClose = quotes[n - 1].qfqClose;
    const secondLastQfqClose = quotes[n - 2].qfqClose;
    expect(lastState.closes[lastState.closes.length - 1]).toBeCloseTo(lastQfqClose, 4);
    expect(secondLastState.closes[secondLastState.closes.length - 1]).toBeCloseTo(secondLastQfqClose, 4);

    // 验证 upsert 收到的 entity 的 state.closes 末尾值与独立 streaming 一致
    const firstEntityState = allStateEntities[0].state as IndicatorCalcState;
    const secondEntityState = allStateEntities[1].state as IndicatorCalcState;
    expect(firstEntityState.closes[firstEntityState.closes.length - 1]).toBeCloseTo(
      secondLastState.closes[secondLastState.closes.length - 1], 4,
    );
    expect(secondEntityState.closes[secondEntityState.closes.length - 1]).toBeCloseTo(
      lastState.closes[lastState.closes.length - 1], 4,
    );
  });
});
