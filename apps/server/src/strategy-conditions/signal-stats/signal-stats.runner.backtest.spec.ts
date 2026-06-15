/**
 * signal-stats.runner.backtest.spec.ts
 *
 * 单测：M1 资金账户层（迷你回测）接线（圈码 ⑤⑥⑦，spec 02/04）。
 *
 * 关注点（与 signal-stats.runner.spec.ts 互补，后者覆盖信号质量层 ①~④）：
 *   - backtestConfig=null → 跳过 ⑤⑥⑦，零漂移（不调 loader、不写 equity、回测列不写）。
 *   - backtestConfig!=null + loader/engine 成功 → 写 equity（先 DELETE）、回测 11 列落库、phase=replaying。
 *   - 回测层抛错（loader 或 engine）→ 独立 try/catch 隔离：
 *       · 不删 trade（顶层 catch 的 tradeRepo.delete 不被触发）
 *       · run 仍 completed（质量层数据保留）
 *       · 回测 11 列置 null + error_message='回测层失败: ...'
 *   - 单源 config 组装：sources[0].runId=本 runId、账户级字段取自 backtestConfig。
 *
 * engine（runPortfolioSim）为纯函数模块导入 → 用 jest.mock 拦截（默认成功，按需 throw）。
 */
import { EngineResult } from '../portfolio-sim/portfolio-sim.types';

// runPortfolioSim 纯函数模块导入：mock 以便逐用例控制成功/抛错。
jest.mock('../portfolio-sim/portfolio-sim.engine', () => ({
  runPortfolioSim: jest.fn(),
}));
import { runPortfolioSim } from '../portfolio-sim/portfolio-sim.engine';
import { SignalStatsRunner } from './signal-stats.runner';
import { SignalTestEntity, SignalTestBacktestConfig } from '../../entities/strategy/signal-test.entity';

const mockedEngine = runPortfolioSim as jest.MockedFunction<typeof runPortfolioSim>;

// ── mock 工厂 ──────────────────────────────────────────────────────────────

function makeMockRunRepo() {
  return {
    update: jest.fn(async () => undefined),
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
  };
}

function makeMockTradeRepo() {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
    delete: jest.fn(async () => undefined),
  };
}

function makeMockEquityRepo() {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
    delete: jest.fn(async () => undefined),
  };
}

function makeMockEnumerator(
  tradingDays: string[],
  allDays: string[],
  signals: Array<{ signalDate: string; tsCode: string }>,
) {
  return {
    listSseTradingDays: jest.fn(async () => tradingDays),
    listAllSseTradingDays: jest.fn(async () => allDays),
    enumerateSignals: jest.fn(async () => signals),
  };
}

function makeMockSimulator(
  outcomes: Array<{ kind: 'trade' | 'filtered'; trade?: Record<string, unknown>; reason?: string }>,
) {
  return {
    simulateSignalsBatched: jest.fn(async (_params: Record<string, unknown>) => outcomes),
  };
}

/** loader.load(config, onGroupDone?) → Promise<LoadResult>（含 input）。
 *  声明形参（即便忽略）让 mock.calls 推断出参数元组，便于断言传入的 config。 */
function makeMockLoader(input: unknown = { config: {}, trades: [], quotes: new Map(), calendar: [] }) {
  return {
    load: jest.fn(
      async (_config: Record<string, unknown>, _onGroupDone?: (done: number) => void) => ({
        input,
        groupTotal: 0,
        appendedCalendarDates: [],
      }),
    ),
  };
}

function makeBacktestConfig(
  overrides: Partial<SignalTestBacktestConfig> = {},
): SignalTestBacktestConfig {
  return {
    initialCapital: 1_000_000,
    cost: {
      commissionPerSide: 0.0003,
      transferPerSide: 0.00001,
      stampSellBefore20230828: 0.001,
      stampSellFrom20230828: 0.0005,
      slippagePerSide: 0.0005,
    },
    anchorMode: false,
    positionRatio: 0.2,
    maxPositions: 5,
    exposureCap: 1,
    rankSpec: { factors: [] },
    sizing: {
      mode: 'fixed',
      floorMult: 0.5,
      capMult: 1.5,
      kellyFraction: 0.5,
      kellyMaxMult: 1,
    },
    circuitBreaker: null,
    ...overrides,
  };
}

function makeEngineResult(): EngineResult {
  return {
    dailyRows: [
      {
        tradeDate: '20240103',
        nav: 1_010_000,
        cash: 800_000,
        dailyRet: 0.01,
        positionCount: 1,
        exposure: 0.2079,
        strategyExposure: { self: 0.2079 },
      },
      {
        tradeDate: '20240108',
        nav: 1_020_000,
        cash: 1_020_000,
        dailyRet: 0.0099,
        positionCount: 0,
        exposure: 0,
        strategyExposure: {},
      },
    ],
    fills: [],
    summary: {
      finalNav: 1_020_000,
      totalRet: 0.02,
      annualRet: 0.5,
      maxDrawdown: -0.03,
      sharpe: 1.2,
      calmar: 16.6,
      dailyWinRate: 0.6,
      dailyKelly: 0.1,
      nTaken: 1,
      nSkipped: 0,
      totalCosts: 320,
    },
  };
}

function makeTestEntity(overrides: Partial<SignalTestEntity> = {}): SignalTestEntity {
  return {
    id: 'test-1',
    name: '测试方案',
    buyConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
    exitMode: 'fixed_n',
    horizonN: 5,
    exitConditions: null,
    maxHold: null,
    bandLockParams: null,
    phaseLockParams: null,
    backtestConfig: null,
    universe: { type: 'all' },
    dateStart: '20240101',
    dateEnd: '20240131',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as SignalTestEntity;
}

interface BuiltRunner {
  runner: SignalStatsRunner;
  runRepo: ReturnType<typeof makeMockRunRepo>;
  tradeRepo: ReturnType<typeof makeMockTradeRepo>;
  equityRepo: ReturnType<typeof makeMockEquityRepo>;
  loader: ReturnType<typeof makeMockLoader>;
}

function buildRunner(opts: {
  signals?: Array<{ signalDate: string; tsCode: string }>;
  tradingDays?: string[];
  outcomes?: Array<{ kind: 'trade' | 'filtered'; trade?: Record<string, unknown>; reason?: string }>;
  loader?: ReturnType<typeof makeMockLoader>;
} = {}): BuiltRunner {
  const runRepo = makeMockRunRepo();
  const tradeRepo = makeMockTradeRepo();
  const equityRepo = makeMockEquityRepo();
  const loader = opts.loader ?? makeMockLoader();

  const tradingDays = opts.tradingDays ?? ['20240102', '20240103', '20240104', '20240105', '20240108'];
  const signals = opts.signals ?? [{ signalDate: '20240102', tsCode: '600519.SH' }];
  const outcomes = opts.outcomes ?? [
    {
      kind: 'trade' as const,
      trade: {
        tsCode: '600519.SH', signalDate: '20240102', buyDate: '20240103',
        exitDate: '20240108', buyPrice: 1000, exitPrice: 1100, ret: 0.1,
        holdDays: 5, exitReason: 'max_hold',
      },
    },
  ];

  const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
  const simulator = makeMockSimulator(outcomes);

  const runner = new SignalStatsRunner(
    runRepo as any,
    tradeRepo as any,
    equityRepo as any,
    enumerator as any,
    simulator as any,
    loader as any,
  );
  return { runner, runRepo, tradeRepo, equityRepo, loader };
}

function findCompletedPayload(
  runRepo: ReturnType<typeof makeMockRunRepo>,
  runId: string,
): Record<string, unknown> | undefined {
  const call = (runRepo.update.mock.calls as unknown[][]).find(
    (c) => c[0] === runId && (c[1] as Record<string, unknown>).status === 'completed',
  );
  return call ? (call[1] as Record<string, unknown>) : undefined;
}

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe('SignalStatsRunner 资金账户层（迷你回测）接线', () => {
  beforeEach(() => {
    mockedEngine.mockReset();
    mockedEngine.mockImplementation(() => makeEngineResult());
  });

  describe('backtestConfig=null → 跳过 ⑤⑥⑦（零漂移）', () => {
    it('不调 loader/engine、不写 equity、回测列不出现在 completed payload', async () => {
      const { runner, runRepo, equityRepo, loader } = buildRunner();

      await runner.executeRun(makeTestEntity({ backtestConfig: null }), 'run-null');

      expect(loader.load).not.toHaveBeenCalled();
      expect(mockedEngine).not.toHaveBeenCalled();
      expect(equityRepo.save).not.toHaveBeenCalled();
      expect(equityRepo.delete).not.toHaveBeenCalled();

      const payload = findCompletedPayload(runRepo, 'run-null');
      expect(payload).toBeDefined();
      // 回测列不在终态 payload 中（信号质量层行为完全不变）
      expect(payload!.finalNav).toBeUndefined();
      expect(payload!.totalRet).toBeUndefined();
      expect(payload!.nTaken).toBeUndefined();
    });
  });

  describe('backtestConfig!=null + 成功 → 写 equity + 回测 11 列', () => {
    it('调 loader.load 传入单源 config（sources[0].runId=本 runId、账户级字段取自 backtestConfig）', async () => {
      const { runner, loader } = buildRunner();
      const bc = makeBacktestConfig({ initialCapital: 2_000_000, anchorMode: false });

      await runner.executeRun(makeTestEntity({ backtestConfig: bc }), 'run-cfg');

      expect(loader.load).toHaveBeenCalledTimes(1);
      const passedConfig = loader.load.mock.calls[0][0] as Record<string, any>;
      expect(Array.isArray(passedConfig.sources)).toBe(true);
      expect(passedConfig.sources).toHaveLength(1);
      expect(passedConfig.sources[0].runId).toBe('run-cfg');
      expect(passedConfig.sources[0].positionRatio).toBe(bc.positionRatio);
      expect(passedConfig.sources[0].maxPositions).toBe(bc.maxPositions);
      expect(passedConfig.sources[0].exposureCap).toBe(bc.exposureCap);
      expect(passedConfig.sources[0].rankSpec).toEqual(bc.rankSpec);
      expect(passedConfig.sources[0].sizing).toEqual(bc.sizing);
      expect(passedConfig.initialCapital).toBe(2_000_000);
      expect(passedConfig.cost).toEqual(bc.cost);
      expect(passedConfig.anchorMode).toBe(false);
      // backtestConfig.circuitBreaker=null → 组装成引擎 config 时归一为 undefined
      // （PortfolioSimConfig.circuitBreaker 是可选字段，null 与 undefined 引擎同义=全关）。
      expect(passedConfig.circuitBreaker).toBeUndefined();

      // engine 收到 loader 产出的 input
      expect(mockedEngine).toHaveBeenCalledTimes(1);
    });

    it('非空 circuitBreaker 原样透传（不被 ?? undefined 误丢）', async () => {
      const { runner, loader } = buildRunner();
      const cb = {
        enableCooldown: true,
        consecutiveLossesThreshold: 3,
        baseCooldownDays: 2,
        maxCooldownDays: 5,
        extendOnLoss: 1,
        reduceOnProfit: 1,
        enableDrawdownHalt: false,
        drawdownHaltPct: 0.15,
        drawdownResumePct: 0.1,
      };
      const bc = makeBacktestConfig({ circuitBreaker: cb });

      await runner.executeRun(makeTestEntity({ backtestConfig: bc }), 'run-cb');

      const passedConfig = loader.load.mock.calls[0][0] as Record<string, any>;
      expect(passedConfig.circuitBreaker).toEqual(cb);
    });

    it('regimes 透传到账户级（与 circuitBreaker 同级，不进 sources[0]）', async () => {
      const { runner, loader } = buildRunner();
      const regimes = [
        {
          conditions: [
            { field: 'oamv_macd', operator: 'gt' as const, value: 0 },
            { field: 'oamv_dif', operator: 'gt' as const, value: 0 },
          ],
          maxPositions: 2,
          positionRatio: 0.45,
        },
      ];
      const bc = makeBacktestConfig({ regimes });

      await runner.executeRun(makeTestEntity({ backtestConfig: bc }), 'run-regime');

      const passedConfig = loader.load.mock.calls[0][0] as Record<string, any>;
      // 账户级原样透传。
      expect(passedConfig.regimes).toEqual(regimes);
      // 不进源行。
      expect(passedConfig.sources[0].regimes).toBeUndefined();
    });

    it('regimes 缺省 → 透传 undefined（零漂移）', async () => {
      const { runner, loader } = buildRunner();
      const bc = makeBacktestConfig(); // 无 regimes
      await runner.executeRun(makeTestEntity({ backtestConfig: bc }), 'run-no-regime');
      const passedConfig = loader.load.mock.calls[0][0] as Record<string, any>;
      expect(passedConfig.regimes).toBeUndefined();
    });

    it('写 equity 前先 DELETE（幂等），逐日行批量 insert', async () => {
      const { runner, equityRepo } = buildRunner();

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-eq');

      expect(equityRepo.delete).toHaveBeenCalledWith({ runId: 'run-eq' });
      // DELETE 必须先于 insert
      const delOrder = equityRepo.delete.mock.invocationCallOrder[0];
      const saveOrder = equityRepo.save.mock.invocationCallOrder[0];
      expect(equityRepo.save).toHaveBeenCalled();
      expect(delOrder).toBeLessThan(saveOrder);

      // 落库的 equity 行映射 EngineDailyRow 子集（numeric 以 string 存）
      const created = equityRepo.create.mock.calls.map((c) => c[0] as Record<string, unknown>);
      expect(created).toHaveLength(2);
      expect(created[0]).toMatchObject({
        runId: 'run-eq',
        tradeDate: '20240103',
        positionCount: 1,
      });
      expect(typeof created[0].nav).toBe('string');
      expect(typeof created[0].cash).toBe('string');
      expect(typeof created[0].dailyRet).toBe('string');
      expect(typeof created[0].exposure).toBe('string');
    });

    it('回测 11 列写入 run（EngineSummary → string/number），run 仍 completed', async () => {
      const { runner, runRepo } = buildRunner();

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-sum');

      const btCall = (runRepo.update.mock.calls as unknown[][]).find(
        (c) => c[0] === 'run-sum' && (c[1] as Record<string, unknown>).finalNav !== undefined,
      );
      expect(btCall).toBeDefined();
      const p = btCall![1] as Record<string, unknown>;
      expect(p.finalNav).toBe('1020000');
      expect(p.totalRet).toBe('0.02');
      expect(p.annualRet).toBe('0.5');
      expect(p.maxDrawdown).toBe('-0.03');
      expect(p.sharpe).toBe('1.2');
      expect(p.calmar).toBe('16.6');
      expect(p.dailyWinRate).toBe('0.6');
      expect(p.dailyKelly).toBe('0.1');
      // n_taken / n_skipped 是 int 列 → number
      expect(p.nTaken).toBe(1);
      expect(p.nSkipped).toBe(0);
      expect(p.totalCosts).toBe('320');

      expect(findCompletedPayload(runRepo, 'run-sum')).toBeDefined();
    });

    it('summary 中 null 字段（annualRet/sharpe/calmar/dailyWinRate/dailyKelly）落库为 null', async () => {
      const result = makeEngineResult();
      result.summary.annualRet = null;
      result.summary.sharpe = null;
      result.summary.calmar = null;
      result.summary.dailyWinRate = null;
      result.summary.dailyKelly = null;
      mockedEngine.mockImplementation(() => result);
      const { runner, runRepo } = buildRunner();

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-nulls');

      const btCall = (runRepo.update.mock.calls as unknown[][]).find(
        (c) => c[0] === 'run-nulls' && (c[1] as Record<string, unknown>).finalNav !== undefined,
      );
      const p = btCall![1] as Record<string, unknown>;
      expect(p.annualRet).toBeNull();
      expect(p.sharpe).toBeNull();
      expect(p.calmar).toBeNull();
      expect(p.dailyWinRate).toBeNull();
      expect(p.dailyKelly).toBeNull();
    });

    it('phase 在质量层之后置 replaying（资金账户层）', async () => {
      const { runner, runRepo } = buildRunner();

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-phase');

      const calls = runRepo.update.mock.calls as unknown[][];
      const replayingIdx = calls.findIndex(
        (c) => c[0] === 'run-phase' && (c[1] as Record<string, unknown>).phase === 'replaying',
      );
      expect(replayingIdx).toBeGreaterThanOrEqual(0);
    });

    it('status=completed 必须排在 equity 写入与回测列写入之后（圈码 ⑧ 终态最后）', async () => {
      const { runner, runRepo, equityRepo } = buildRunner();

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-last');

      // status=completed 的那次 update 调用序号
      const completedIdx = (runRepo.update.mock.calls as unknown[][]).findIndex(
        (c) => c[0] === 'run-last' && (c[1] as Record<string, unknown>).status === 'completed',
      );
      expect(completedIdx).toBeGreaterThanOrEqual(0);
      const completedOrder = runRepo.update.mock.invocationCallOrder[completedIdx];

      // equity 写入（save）必须先于 completed
      const equitySaveOrder = equityRepo.save.mock.invocationCallOrder[0];
      expect(equitySaveOrder).toBeLessThan(completedOrder);

      // 回测列写入（含 finalNav 的 update）必须先于 completed
      const btIdx = (runRepo.update.mock.calls as unknown[][]).findIndex(
        (c) => c[0] === 'run-last' && (c[1] as Record<string, unknown>).finalNav !== undefined,
      );
      const btOrder = runRepo.update.mock.invocationCallOrder[btIdx];
      expect(btOrder).toBeLessThan(completedOrder);
    });
  });

  describe('错误边界：回测层抛错绝不冒泡到顶层（不删 trade）', () => {
    it('loader.load 抛错 → 不删 trade、run=completed、回测列置 null + error_message', async () => {
      const badLoader = {
        load: jest.fn(async () => {
          throw new Error('loader boom');
        }),
      };
      const { runner, runRepo, tradeRepo, equityRepo } = buildRunner({ loader: badLoader as any });

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-loader-fail');

      // 顶层 catch 的 tradeRepo.delete 不被触发（质量层 trade 保留）
      expect(tradeRepo.delete).not.toHaveBeenCalled();
      // 质量层照常 completed
      expect(findCompletedPayload(runRepo, 'run-loader-fail')).toBeDefined();
      // 不写 equity
      expect(equityRepo.save).not.toHaveBeenCalled();
      // 回测列置 null + error_message
      const failCall = (runRepo.update.mock.calls as unknown[][]).find(
        (c) => {
          const p = c[1] as Record<string, unknown>;
          return c[0] === 'run-loader-fail' && p.finalNav === null && typeof p.errorMessage === 'string';
        },
      );
      expect(failCall).toBeDefined();
      const p = failCall![1] as Record<string, unknown>;
      expect(p.finalNav).toBeNull();
      expect(p.totalRet).toBeNull();
      expect(p.nTaken).toBeNull();
      expect(p.nSkipped).toBeNull();
      expect(p.totalCosts).toBeNull();
      expect(String(p.errorMessage)).toContain('回测层失败');
      expect(String(p.errorMessage)).toContain('loader boom');
      // run.status 不应被回测层 catch 置 failed
      expect(p.status).toBeUndefined();
    });

    it('engine 抛错 → 同样隔离（不删 trade、completed、回测列 null）', async () => {
      mockedEngine.mockImplementation(() => {
        throw new Error('engine boom');
      });
      const { runner, runRepo, tradeRepo } = buildRunner();

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-engine-fail');

      expect(tradeRepo.delete).not.toHaveBeenCalled();
      expect(findCompletedPayload(runRepo, 'run-engine-fail')).toBeDefined();
      const failCall = (runRepo.update.mock.calls as unknown[][]).find(
        (c) => {
          const p = c[1] as Record<string, unknown>;
          return c[0] === 'run-engine-fail' && p.finalNav === null && typeof p.errorMessage === 'string';
        },
      );
      expect(failCall).toBeDefined();
      expect(String((failCall![1] as Record<string, unknown>).errorMessage)).toContain('engine boom');
    });

    it('质量层（simulator）抛错 → 顶层 catch 删 trade + failed（回测层不介入）', async () => {
      const badSimulator = {
        simulateSignalsBatched: jest.fn(async () => {
          throw new Error('sim boom');
        }),
      };
      const runRepo = makeMockRunRepo();
      const tradeRepo = makeMockTradeRepo();
      const equityRepo = makeMockEquityRepo();
      const loader = makeMockLoader();
      const enumerator = makeMockEnumerator(['20240102'], ['20240102'], [
        { signalDate: '20240102', tsCode: '600519.SH' },
      ]);
      const runner = new SignalStatsRunner(
        runRepo as any,
        tradeRepo as any,
        equityRepo as any,
        enumerator as any,
        badSimulator as any,
        loader as any,
      );

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-quality-fail');

      // 顶层删 trade + failed（既有行为，不变）
      expect(tradeRepo.delete).toHaveBeenCalledWith({ runId: 'run-quality-fail' });
      expect(runRepo.update).toHaveBeenCalledWith(
        'run-quality-fail',
        expect.objectContaining({ status: 'failed', errorMessage: 'sim boom' }),
      );
      // 回测层未介入
      expect(loader.load).not.toHaveBeenCalled();
      expect(equityRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('0 trade 时回测层处理', () => {
    it('全被过滤（0 trade）→ 早退，不进回测层', async () => {
      const { runner, loader, equityRepo } = buildRunner({
        outcomes: [{ kind: 'filtered', reason: 'suspended' }],
      });

      await runner.executeRun(makeTestEntity({ backtestConfig: makeBacktestConfig() }), 'run-0trade');

      // 0 trade 时质量层早退 completed，无逐笔可回放 → 不调 loader
      expect(loader.load).not.toHaveBeenCalled();
      expect(equityRepo.save).not.toHaveBeenCalled();
    });
  });
});
