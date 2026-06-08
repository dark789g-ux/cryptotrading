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
    simulateSignalsBatched: jest.fn(async () => outcomes),
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
});
