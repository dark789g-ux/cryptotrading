/**
 * signal-stats.runner.spec.ts
 *
 * 单测：Runner 编排逻辑（mock enumerator/simulator/metrics/repos）。
 * 验证：
 *   - 0 交易日 → 直接 completed，sampleCount=0，不调 simulator。
 *   - 0 信号 → 直接 completed，sampleCount=0，不调 simulator。
 *   - 全被过滤 → completed，sampleCount=0，filteredCount>0。
 *   - 正常成交 → completed，调 calcSignalStats，落库聚合指标 + 插入 trade。
 *   - 模拟异常 → run.status='failed' + errorMessage（不静默吞）。
 */
import { SignalStatsRunner } from './signal-stats.runner';
import { SignalTestEntity } from '../../entities/strategy/signal-test.entity';

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

function makeMockEnumerator(
  tradingDays: string[],
  allDays: string[],
  signals: Array<{ signalDate: string; tsCode: string }>,
) {
  return {
    listSseTradingDays: jest.fn(async () => tradingDays),
    listAllSseTradingDays: jest.fn(async () => allDays),
    enumerateSignals: jest.fn(
      async (
        _buyConditions: unknown,
        _dateStart: unknown,
        _dateEnd: unknown,
        _universe: unknown,
        onProgress?: (scanned: number, total: number) => void | Promise<void>,
      ) => {
        // 触发进度回调
        for (let i = 0; i < tradingDays.length; i++) {
          if (onProgress) await onProgress(i + 1, tradingDays.length);
        }
        return signals;
      },
    ),
  };
}

function makeMockSimulator(
  outcomes: Array<{ kind: 'trade' | 'filtered'; trade?: Record<string, unknown>; reason?: string }>,
) {
  return {
    // 声明形参（即便忽略）让 mock.calls 推断出参数元组，便于断言传入的 exit 配置。
    simulateSignalsBatched: jest.fn(async (_params: Record<string, unknown>) => outcomes),
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
    universe: { type: 'all' },
    dateStart: '20240101',
    dateEnd: '20240131',
    createdAt: new Date(),
    updatedAt: new Date(),
    ...overrides,
  } as SignalTestEntity;
}

function buildRunner(
  enumerator: ReturnType<typeof makeMockEnumerator>,
  simulator: ReturnType<typeof makeMockSimulator>,
  runRepo?: ReturnType<typeof makeMockRunRepo>,
  tradeRepo?: ReturnType<typeof makeMockTradeRepo>,
): SignalStatsRunner {
  const rr = runRepo ?? makeMockRunRepo();
  const tr = tradeRepo ?? makeMockTradeRepo();
  return new SignalStatsRunner(rr as any, tr as any, enumerator as any, simulator as any);
}

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe('SignalStatsRunner', () => {
  describe('0 交易日', () => {
    it('无交易日时 → completed sampleCount=0，不调 simulator', async () => {
      const runRepo = makeMockRunRepo();
      const simulator = makeMockSimulator([]);
      const enumerator = makeMockEnumerator([], [], []);
      const runner = buildRunner(enumerator, simulator, runRepo);

      await runner.executeRun(makeTestEntity(), 'run-1');

      expect(runRepo.update).toHaveBeenCalledWith('run-1', expect.objectContaining({
        status: 'completed',
        sampleCount: 0,
        filteredCount: 0,
      }));
      expect(simulator.simulateSignalsBatched).not.toHaveBeenCalled();
    });
  });

  describe('0 信号', () => {
    it('区间内无买入信号 → completed sampleCount=0，不调 simulator', async () => {
      const runRepo = makeMockRunRepo();
      const simulator = makeMockSimulator([]);
      const tradingDays = ['20240102', '20240103'];
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, []);
      const runner = buildRunner(enumerator, simulator, runRepo);

      await runner.executeRun(makeTestEntity(), 'run-1');

      expect(runRepo.update).toHaveBeenCalledWith('run-1', expect.objectContaining({
        status: 'completed',
        sampleCount: 0,
        filteredCount: 0,
      }));
      expect(simulator.simulateSignalsBatched).not.toHaveBeenCalled();
    });
  });

  describe('全被过滤', () => {
    it('所有信号被过滤 → completed sampleCount=0 filteredCount>0', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103'];
      const signals = [
        { signalDate: '20240102', tsCode: '600519.SH' },
        { signalDate: '20240103', tsCode: '000001.SZ' },
      ];
      const simulator = makeMockSimulator([
        { kind: 'filtered', reason: 'suspended' },
        { kind: 'filtered', reason: 'limit_up' },
      ]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const tradeRepo = makeMockTradeRepo();
      const runner = buildRunner(enumerator, simulator, runRepo, tradeRepo);

      await runner.executeRun(makeTestEntity(), 'run-1');

      const updateCall = (runRepo.update.mock.calls as unknown[][]).find(
        (c) => c[0] === 'run-1' && (c[1] as Record<string, unknown>).status === 'completed',
      );
      expect(updateCall).toBeDefined();
      const payload = (updateCall as unknown[])[1] as Record<string, unknown>;
      expect(payload.sampleCount).toBe(0);
      expect(payload.filteredCount).toBe(2);
      // 无 trade 插入
      expect(tradeRepo.save).not.toHaveBeenCalled();
    });
  });

  describe('正常成交', () => {
    it('有成交 → completed 落库聚合指标 + 插入 trade', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103', '20240104', '20240105', '20240108'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const trade = {
        tsCode: '600519.SH',
        signalDate: '20240102',
        buyDate: '20240103',
        exitDate: '20240108',
        buyPrice: 1000,
        exitPrice: 1100,
        ret: 0.1,
        holdDays: 5,
        exitReason: 'max_hold',
      };
      const simulator = makeMockSimulator([{ kind: 'trade', trade }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const tradeRepo = makeMockTradeRepo();
      const runner = buildRunner(enumerator, simulator, runRepo, tradeRepo);

      await runner.executeRun(makeTestEntity(), 'run-1');

      const completedCall = (runRepo.update.mock.calls as unknown[][]).find(
        (c) => c[0] === 'run-1' && (c[1] as Record<string, unknown>).status === 'completed',
      );
      expect(completedCall).toBeDefined();
      const payload = (completedCall as unknown[])[1] as Record<string, unknown>;
      expect(payload.sampleCount).toBe(1);
      expect(payload.filteredCount).toBe(0);
      // winRate: 1 win out of 1 → 1.0
      expect(payload.winRate).toBe('1');
      // 插入 trade
      expect(tradeRepo.save).toHaveBeenCalled();
    });
  });

  describe('exitMode=trailing_lock 接线', () => {
    it('带 maxHold → 传给 simulator 的 exit 为 {mode:trailing_lock, maxHold}，trade(stop/ma5_exit) 正常落库', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103', '20240104', '20240105', '20240108'];
      const signals = [
        { signalDate: '20240102', tsCode: '600519.SH' },
        { signalDate: '20240103', tsCode: '000001.SZ' },
      ];
      // 两条 trailing_lock 出场：一条 stop、一条 ma5_exit。
      const tradeStop = {
        tsCode: '600519.SH', signalDate: '20240102', buyDate: '20240103',
        exitDate: '20240105', buyPrice: 1000, exitPrice: 980, ret: -0.02,
        holdDays: 2, exitReason: 'stop',
      };
      const tradeMa5 = {
        tsCode: '000001.SZ', signalDate: '20240103', buyDate: '20240104',
        exitDate: '20240108', buyPrice: 100, exitPrice: 108, ret: 0.08,
        holdDays: 3, exitReason: 'ma5_exit',
      };
      const simulator = makeMockSimulator([
        { kind: 'trade', trade: tradeStop },
        { kind: 'trade', trade: tradeMa5 },
      ]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const tradeRepo = makeMockTradeRepo();
      const runner = buildRunner(enumerator, simulator, runRepo, tradeRepo);

      await runner.executeRun(
        makeTestEntity({ exitMode: 'trailing_lock', horizonN: null, exitConditions: null, maxHold: 10 }),
        'run-tl',
      );

      // 1) simulator 收到的 exit 配置正确 + exitConditions=null（trailing_lock 不传卖出条件）
      //    bandLockParams=null → 4 个 band_lock 字段回落默认（0.999/0.999/true/true）。
      expect(simulator.simulateSignalsBatched).toHaveBeenCalledTimes(1);
      const params = simulator.simulateSignalsBatched.mock.calls[0][0] as Record<string, unknown>;
      expect(params.exit).toEqual({
        mode: 'trailing_lock',
        maxHold: 10,
        stopRatio: 0.999,
        floorRatio: 0.999,
        floorEnabled: true,
        ma5RequireDown: true,
      });
      expect(params.exitConditions).toBeNull();

      // 2) 两条 trade 落库（含 stop / ma5_exit reason 透传）
      const created = tradeRepo.create.mock.calls.map((c) => c[0] as Record<string, unknown>);
      const reasons = created.map((t) => t.exitReason);
      expect(reasons).toContain('stop');
      expect(reasons).toContain('ma5_exit');
      expect(tradeRepo.save).toHaveBeenCalled();

      // 3) run 标 completed，sampleCount=2
      const completedCall = (runRepo.update.mock.calls as unknown[][]).find(
        (c) => c[0] === 'run-tl' && (c[1] as Record<string, unknown>).status === 'completed',
      );
      expect(completedCall).toBeDefined();
      expect((completedCall as unknown[])[1]).toMatchObject({ sampleCount: 2, filteredCount: 0 });
    });

    it('留空 maxHold → exit 为 {mode:trailing_lock, maxHold:undefined}（无硬上限）', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const simulator = makeMockSimulator([{ kind: 'filtered', reason: 'insufficient_data' }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const runner = buildRunner(enumerator, simulator, runRepo);

      await runner.executeRun(
        makeTestEntity({ exitMode: 'trailing_lock', horizonN: null, exitConditions: null, maxHold: null }),
        'run-tl-nocap',
      );

      const params = simulator.simulateSignalsBatched.mock.calls[0][0] as Record<string, unknown>;
      expect(params.exit).toEqual({
        mode: 'trailing_lock',
        maxHold: undefined,
        stopRatio: 0.999,
        floorRatio: 0.999,
        floorEnabled: true,
        ma5RequireDown: true,
      });
    });

    it('bandLockParams 非默认 → 透传量化值进 ExitConfig（不回落默认）', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const simulator = makeMockSimulator([{ kind: 'filtered', reason: 'insufficient_data' }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const runner = buildRunner(enumerator, simulator, runRepo);

      await runner.executeRun(
        makeTestEntity({
          exitMode: 'trailing_lock',
          horizonN: null,
          exitConditions: null,
          maxHold: null,
          // 已是量化后的网格点值（service 落库时量化，runner 直接透传，核不再量化）
          bandLockParams: {
            stopRatio: 0.951,
            floorRatio: 1.5,
            floorEnabled: false,
            ma5RequireDown: false,
          },
        }),
        'run-tl-params',
      );

      const params = simulator.simulateSignalsBatched.mock.calls[0][0] as Record<string, unknown>;
      expect(params.exit).toEqual({
        mode: 'trailing_lock',
        maxHold: undefined,
        stopRatio: 0.951,
        floorRatio: 1.5,
        floorEnabled: false,
        ma5RequireDown: false,
      });
    });
  });

  describe('skipNewListingFilter 透传（买入条件含 list_days 时跳过次新硬过滤）', () => {
    it('buyConditions 含 list_days → simulator 收到 skipNewListingFilter=true', async () => {
      const tradingDays = ['20240102', '20240103'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const simulator = makeMockSimulator([{ kind: 'filtered', reason: 'insufficient_data' }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const runner = buildRunner(enumerator, simulator);

      await runner.executeRun(
        makeTestEntity({
          buyConditions: [
            { field: 'macd_hist', operator: 'gt', value: 0 },
            { field: 'list_days', operator: 'gt', value: 365 },
          ],
        }),
        'run-ld',
      );

      const params = simulator.simulateSignalsBatched.mock.calls[0][0] as Record<string, unknown>;
      expect(params.skipNewListingFilter).toBe(true);
    });

    it('buyConditions 不含 list_days → skipNewListingFilter=false（默认行为不变）', async () => {
      const tradingDays = ['20240102', '20240103'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const simulator = makeMockSimulator([{ kind: 'filtered', reason: 'insufficient_data' }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const runner = buildRunner(enumerator, simulator);

      await runner.executeRun(makeTestEntity(), 'run-no-ld');

      const params = simulator.simulateSignalsBatched.mock.calls[0][0] as Record<string, unknown>;
      expect(params.skipNewListingFilter).toBe(false);
    });
  });

  describe('落库顺序：插入 trade 必须先于标 completed（reorder 防竞态）', () => {
    it('tradeRepo.save 在 runRepo.update({status:completed}) 之前调用', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103', '20240104', '20240105', '20240108'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const trade = {
        tsCode: '600519.SH', signalDate: '20240102', buyDate: '20240103',
        exitDate: '20240108', buyPrice: 1000, exitPrice: 1100, ret: 0.1,
        holdDays: 5, exitReason: 'max_hold',
      };
      const simulator = makeMockSimulator([{ kind: 'trade', trade }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const tradeRepo = makeMockTradeRepo();
      const runner = buildRunner(enumerator, simulator, runRepo, tradeRepo);

      await runner.executeRun(makeTestEntity(), 'run-order');

      // 首次 trade 写入的全局调用序号（jest 跨 mock 单调计数）
      expect(tradeRepo.save).toHaveBeenCalled();
      const firstSaveOrder = tradeRepo.save.mock.invocationCallOrder[0];
      // 标 completed 的 runRepo.update 调用序号
      const completedIdx = (runRepo.update.mock.calls as unknown[][]).findIndex(
        (c) => c[0] === 'run-order' && (c[1] as Record<string, unknown>).status === 'completed',
      );
      expect(completedIdx).toBeGreaterThanOrEqual(0);
      const completedOrder = runRepo.update.mock.invocationCallOrder[completedIdx];
      // 插入必须先于标 completed
      expect(firstSaveOrder).toBeLessThan(completedOrder);
    });
  });

  describe('异常处理', () => {
    it('enumerator 抛出异常 → run.status=failed + errorMessage（不静默吞）', async () => {
      const runRepo = makeMockRunRepo();
      const badEnumerator = {
        listSseTradingDays: jest.fn(async () => { throw new Error('DB connection failed'); }),
        listAllSseTradingDays: jest.fn(async () => []),
        enumerateSignals: jest.fn(async () => []),
      };
      const simulator = makeMockSimulator([]);
      const runner = buildRunner(badEnumerator as any, simulator, runRepo);

      await runner.executeRun(makeTestEntity(), 'run-fail');

      expect(runRepo.update).toHaveBeenCalledWith('run-fail', expect.objectContaining({
        status: 'failed',
        errorMessage: 'DB connection failed',
      }));
    });

    it('simulator 抛出异常 → run.status=failed + errorMessage', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const badSimulator = {
        simulateSignalsBatched: jest.fn(async () => { throw new Error('Simulator crash'); }),
      };
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const runner = buildRunner(enumerator, badSimulator as any, runRepo);

      await runner.executeRun(makeTestEntity(), 'run-fail');

      expect(runRepo.update).toHaveBeenCalledWith('run-fail', expect.objectContaining({
        status: 'failed',
        errorMessage: 'Simulator crash',
      }));
    });

    it('插入逐笔中途失败 → run 落 failed（不先 completed）+ 清理半截 trade', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103', '20240104', '20240105', '20240108'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const trade = {
        tsCode: '600519.SH', signalDate: '20240102', buyDate: '20240103',
        exitDate: '20240108', buyPrice: 1000, exitPrice: 1100, ret: 0.1,
        holdDays: 5, exitReason: 'max_hold',
      };
      const simulator = makeMockSimulator([{ kind: 'trade', trade }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const tradeRepo = makeMockTradeRepo();
      // 注入插入失败
      tradeRepo.save = jest.fn(async (_e: unknown) => { throw new Error('insert batch failed'); });
      const runner = buildRunner(enumerator, simulator, runRepo, tradeRepo);

      await runner.executeRun(makeTestEntity(), 'run-insert-fail');

      // 插入排在标 completed 之前，失败时尚未标 completed → 不应出现 completed
      const completedCall = (runRepo.update.mock.calls as unknown[][]).find(
        (c) => c[0] === 'run-insert-fail' && (c[1] as Record<string, unknown>).status === 'completed',
      );
      expect(completedCall).toBeUndefined();
      // 落 failed
      expect(runRepo.update).toHaveBeenCalledWith('run-insert-fail', expect.objectContaining({
        status: 'failed',
        errorMessage: 'insert batch failed',
      }));
      // 清理半截 trade
      expect(tradeRepo.delete).toHaveBeenCalledWith({ runId: 'run-insert-fail' });
    });
  });

  describe('进度更新', () => {
    it('enumerateSignals 的 onProgress 回调被调用 → 更新 progress_scanned', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103'];
      const signals: Array<{ signalDate: string; tsCode: string }> = [];
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const simulator = makeMockSimulator([]);
      const runner = buildRunner(enumerator, simulator, runRepo);

      await runner.executeRun(makeTestEntity(), 'run-progress');

      // 检查是否有 progressScanned 更新
      const progressUpdates = runRepo.update.mock.calls.filter(
        (c: unknown[]) => (c[1] as Record<string, unknown>).progressScanned !== undefined,
      );
      // 进度更新通过 onProgress 回调驱动（2 天 → 2 次 + 最终 completed 一次）
      expect(progressUpdates.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe('phase 三阶段按序写入', () => {
    it('正常成交：phase 按序 scanning → simulating(带 progressTotal=signals.length) → writing(带 progressTotal=trades.length) → completed', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103', '20240104', '20240105', '20240108'];
      const signals = [
        { signalDate: '20240102', tsCode: '600519.SH' },
        { signalDate: '20240103', tsCode: '000001.SZ' },
      ];
      const trade1 = {
        tsCode: '600519.SH', signalDate: '20240102', buyDate: '20240103',
        exitDate: '20240108', buyPrice: 1000, exitPrice: 1100, ret: 0.1,
        holdDays: 5, exitReason: 'max_hold',
      };
      const trade2 = {
        tsCode: '000001.SZ', signalDate: '20240103', buyDate: '20240104',
        exitDate: '20240108', buyPrice: 10, exitPrice: 11, ret: 0.1,
        holdDays: 4, exitReason: 'max_hold',
      };
      const simulator = makeMockSimulator([
        { kind: 'trade', trade: trade1 },
        { kind: 'trade', trade: trade2 },
      ]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const tradeRepo = makeMockTradeRepo();
      const runner = buildRunner(enumerator, simulator, runRepo, tradeRepo);

      await runner.executeRun(makeTestEntity(), 'run-phase');

      const calls = runRepo.update.mock.calls as unknown[][];

      // 提取各 phase 写入的索引位置（按调用顺序）
      const scanningIdx = calls.findIndex(
        (c) => c[0] === 'run-phase' && (c[1] as Record<string, unknown>).phase === 'scanning',
      );
      const simulatingIdx = calls.findIndex(
        (c) => c[0] === 'run-phase' && (c[1] as Record<string, unknown>).phase === 'simulating',
      );
      const writingIdx = calls.findIndex(
        (c) => c[0] === 'run-phase' && (c[1] as Record<string, unknown>).phase === 'writing',
      );
      const completedIdx = calls.findIndex(
        (c) => c[0] === 'run-phase' && (c[1] as Record<string, unknown>).status === 'completed',
      );

      // 四阶段均已触发
      expect(scanningIdx).toBeGreaterThanOrEqual(0);
      expect(simulatingIdx).toBeGreaterThanOrEqual(0);
      expect(writingIdx).toBeGreaterThanOrEqual(0);
      expect(completedIdx).toBeGreaterThanOrEqual(0);

      // 顺序：scanning < simulating < writing < completed
      expect(scanningIdx).toBeLessThan(simulatingIdx);
      expect(simulatingIdx).toBeLessThan(writingIdx);
      expect(writingIdx).toBeLessThan(completedIdx);

      // simulating 带 progressTotal=signals.length（=2）和 progressScanned=0
      const simulatingPayload = calls[simulatingIdx][1] as Record<string, unknown>;
      expect(simulatingPayload.progressTotal).toBe(2); // signals.length
      expect(simulatingPayload.progressScanned).toBe(0);

      // writing 带 progressTotal=trades.length（=2）和 progressScanned=0
      const writingPayload = calls[writingIdx][1] as Record<string, unknown>;
      expect(writingPayload.progressTotal).toBe(2); // trades.length
      expect(writingPayload.progressScanned).toBe(0);
    });

    it('0 信号早退：phase 停在 scanning，直接 completed，不触发 simulating/writing', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103'];
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, []);
      const simulator = makeMockSimulator([]);
      const runner = buildRunner(enumerator, simulator, runRepo);

      await runner.executeRun(makeTestEntity(), 'run-phase-early');

      const calls = runRepo.update.mock.calls as unknown[][];

      const scanningIdx = calls.findIndex(
        (c) => c[0] === 'run-phase-early' && (c[1] as Record<string, unknown>).phase === 'scanning',
      );
      const simulatingIdx = calls.findIndex(
        (c) => c[0] === 'run-phase-early' && (c[1] as Record<string, unknown>).phase === 'simulating',
      );
      const writingIdx = calls.findIndex(
        (c) => c[0] === 'run-phase-early' && (c[1] as Record<string, unknown>).phase === 'writing',
      );

      // scanning 触发，simulating/writing 不触发（0 信号早退）
      expect(scanningIdx).toBeGreaterThanOrEqual(0);
      expect(simulatingIdx).toBe(-1);
      expect(writingIdx).toBe(-1);
    });

    it('全被过滤（0 trade）：simulating 触发，writing 不触发', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const simulator = makeMockSimulator([{ kind: 'filtered', reason: 'suspended' }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const runner = buildRunner(enumerator, simulator, runRepo);

      await runner.executeRun(makeTestEntity(), 'run-phase-filtered');

      const calls = runRepo.update.mock.calls as unknown[][];

      const simulatingIdx = calls.findIndex(
        (c) => c[0] === 'run-phase-filtered' && (c[1] as Record<string, unknown>).phase === 'simulating',
      );
      const writingIdx = calls.findIndex(
        (c) => c[0] === 'run-phase-filtered' && (c[1] as Record<string, unknown>).phase === 'writing',
      );

      // 有信号但全过滤：simulating 触发，writing 不触发
      expect(simulatingIdx).toBeGreaterThanOrEqual(0);
      expect(writingIdx).toBe(-1);
    });
  });

  describe('simulator onGroupDone 累加验证', () => {
    it('simulateSignalsBatched 收到的 onGroupDone 被正确调用：次数=tsCode 组数，累加和=signals.length', async () => {
      // 用真实（非 mock）simulator 来验证 onGroupDone，需要拦截 simulateSignalsBatched 调用
      // 策略：mock simulator 记录传入的 onGroupDone，然后手动模拟调用
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103'];
      // 3 个信号，2 个 tsCode（600519.SH × 2，000001.SZ × 1）
      const signals = [
        { signalDate: '20240102', tsCode: '600519.SH' },
        { signalDate: '20240103', tsCode: '600519.SH' },
        { signalDate: '20240102', tsCode: '000001.SZ' },
      ];

      let capturedOnGroupDone: ((n: number) => void) | undefined;
      const mockSimulator = {
        simulateSignalsBatched: jest.fn(async (params: Record<string, unknown>) => {
          capturedOnGroupDone = params.onGroupDone as (n: number) => void;
          // 模拟批量路径：600519.SH 组有 2 个信号，000001.SZ 组有 1 个信号
          capturedOnGroupDone?.(2); // 600519.SH 组完成
          capturedOnGroupDone?.(1); // 000001.SZ 组完成
          // 返回 3 个过滤结果（不需要真实 trade）
          return [
            { kind: 'filtered', reason: 'insufficient_data' },
            { kind: 'filtered', reason: 'insufficient_data' },
            { kind: 'filtered', reason: 'insufficient_data' },
          ];
        }),
      };
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const runner = buildRunner(enumerator, mockSimulator as any, runRepo);

      await runner.executeRun(makeTestEntity(), 'run-group-done');

      // onGroupDone 应被调用 2 次（2 个 tsCode 组），参数分别为 2 和 1，累加和=3=signals.length
      expect(mockSimulator.simulateSignalsBatched).toHaveBeenCalledTimes(1);
      const passedParams = mockSimulator.simulateSignalsBatched.mock.calls[0][0] as Record<string, unknown>;
      expect(typeof passedParams.onGroupDone).toBe('function');

      // 验证通过调用 onGroupDone 产生的效果：最终 sim.stop() 写入的 progressScanned 应=累加和=3
      // 注：由于节流，stop() 最终矫正的 progressScanned 会写入 current=3（2+1）
      // 我们通过 runRepo.update 的调用序列来验证
      const calls = runRepo.update.mock.calls as unknown[][];
      // 找到 sim.stop() 的最终矫正 update（在 simulating 阶段结束时）
      // 模拟阶段结束后会有 stop() 写入，progressScanned 应为 3
      const simStopUpdate = calls.find(
        (c) =>
          c[0] === 'run-group-done' &&
          (c[1] as Record<string, unknown>).progressScanned === 3 &&
          (c[1] as Record<string, unknown>).phase === undefined &&
          (c[1] as Record<string, unknown>).status === undefined,
      );
      expect(simStopUpdate).toBeDefined();
    });
  });

  describe('insertTradesBatched 进度上报节流', () => {
    it('trades < BATCH*FLUSH_EVERY(=2000) 时：末批矫正仍写入正确 progressScanned', async () => {
      const runRepo = makeMockRunRepo();
      const tradingDays = ['20240102', '20240103', '20240104', '20240105', '20240108'];
      const signals = [{ signalDate: '20240102', tsCode: '600519.SH' }];
      const trade = {
        tsCode: '600519.SH', signalDate: '20240102', buyDate: '20240103',
        exitDate: '20240108', buyPrice: 1000, exitPrice: 1100, ret: 0.1,
        holdDays: 5, exitReason: 'max_hold',
      };
      const simulator = makeMockSimulator([{ kind: 'trade', trade }]);
      const enumerator = makeMockEnumerator(tradingDays, tradingDays, signals);
      const tradeRepo = makeMockTradeRepo();
      const runner = buildRunner(enumerator, simulator, runRepo, tradeRepo);

      await runner.executeRun(makeTestEntity(), 'run-writing-flush');

      const calls = runRepo.update.mock.calls as unknown[][];

      // writing 阶段之后，应有末批矫正：progressScanned=1（1 条 trade）
      // 找写入 progressScanned 且值为 1 的调用（排除 phase 和 status 等其他字段）
      const writingFlush = calls.find(
        (c) => {
          const payload = c[1] as Record<string, unknown>;
          return (
            c[0] === 'run-writing-flush' &&
            payload.progressScanned === 1 &&
            payload.phase === undefined &&
            payload.status === undefined &&
            payload.progressTotal === undefined
          );
        },
      );
      expect(writingFlush).toBeDefined();
    });
  });
});
