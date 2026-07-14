import { filterExistingDates, fetchByDates } from './money-flow-sync.helpers';

// mock runWithRetry: directly call fn (no retry delay)
jest.mock('../_shared/sync-helpers', () => {
  const original = jest.requireActual('../_shared/sync-helpers');
  return {
    ...original,
    runWithRetry: jest.fn((_fn: () => Promise<unknown>, _onRetry?: (attempt: number, err: unknown) => void) =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (_fn as any)(),
    ),
  };
});

/**
 * filterExistingDates 的 category 收敛回归测试。
 *
 * 背景（真实 bug）：index_daily_quotes 同表混装 market/industry/concept/sw 四类，
 * sw 增量同步若不按 category='sw' 收敛，会被同表 industry/concept（ths 先写）已写的
 * 同一 trade_date 误判为「已同步」而整窗口跳过——导致申万指数停更。
 *
 * 本文件用 mock queryBuilder，只能验证「是否带上了 category 收敛子句 + 入参」与
 * 「已存在日期被剔除」的纯逻辑；真正的 SQL 语义须靠集成/真机验证。
 */
describe('filterExistingDates', () => {
  function makeRepo(existing: Array<{ tradeDate: string }>) {
    const qb = {
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      getRawMany: jest.fn().mockResolvedValue(existing),
    };
    return {
      qb,
      repo: { createQueryBuilder: jest.fn().mockReturnValue(qb) } as never,
    };
  }

  it('不传 categoryScope：不加 category 子句，按 trade_date 剔除已存在日期', async () => {
    const { qb, repo } = makeRepo([{ tradeDate: '20260623' }]);
    const res = await filterExistingDates(repo, ['20260623', '20260624', '20260625']);
    expect(res).toEqual({ dates: ['20260624', '20260625'], skipped: 1 });
    expect(qb.andWhere).not.toHaveBeenCalled();
  });

  it('categoryScope=单值：带 category IN (:cats) 且 cats=[值]', async () => {
    const { qb, repo } = makeRepo([]);
    await filterExistingDates(repo, ['20260624', '20260625'], 'sw');
    expect(qb.andWhere).toHaveBeenCalledWith('e.category IN (:...cats)', {
      cats: ['sw'],
    });
  });

  it('categoryScope=数组：cats 原样透传', async () => {
    const { qb, repo } = makeRepo([]);
    await filterExistingDates(repo, ['20260625'], ['industry', 'concept']);
    expect(qb.andWhere).toHaveBeenCalledWith('e.category IN (:...cats)', {
      cats: ['industry', 'concept'],
    });
  });

  it('收敛后查询返回空：所有日期均视为未同步（不被他类污染）', async () => {
    // 模拟 sw 收敛后查不到任何 sw 行（尽管同表有 industry/concept 的同日数据）
    const { repo } = makeRepo([]);
    const res = await filterExistingDates(repo, ['20260624', '20260625'], 'sw');
    expect(res).toEqual({ dates: ['20260624', '20260625'], skipped: 0 });
  });
});

describe('fetchByDates', () => {
  function makeClient(mockFn: jest.Mock) {
    return { query: mockFn } as unknown as import('./money-flow-sync.helpers').FetchByDatesOptions<never>['client'];
  }

  function makeLogger() {
    return { warn: jest.fn(), error: jest.fn(), log: jest.fn() } as unknown as import('@nestjs/common').Logger;
  }

  function makeCtx(overrides?: Partial<import('./money-flow-sync.helpers').SyncCtx>) {
    return {
      phase: 'test',
      baseCurrent: 0,
      total: 3,
      grandTotal: 3,
      emit: jest.fn(),
      signal: undefined,
      ...overrides,
    } as import('./money-flow-sync.helpers').SyncCtx;
  }

  it('多日并发完成：3 个日期返回不同行数，rowsByDate 包含全部、errors 为空', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ a: 1 }])
      .mockResolvedValueOnce([{ a: 2 }, { a: 3 }])
      .mockResolvedValueOnce([{ a: 4 }, { a: 5 }, { a: 6 }]);

    const result = await fetchByDates({
      apiName: 'test_api',
      fields: 'a',
      dates: ['20260701', '20260702', '20260703'],
      ctx: makeCtx(),
      logger: makeLogger(),
      client: makeClient(query),
    });

    expect(result.errors).toEqual([]);
    expect(result.rowsByDate).toHaveLength(3);
    // Each date has correct row count (order may differ due to concurrency)
    const byDate = new Map(result.rowsByDate.map((r) => [r.date, r.rows.length]));
    expect(byDate.get('20260701')).toBe(1);
    expect(byDate.get('20260702')).toBe(2);
    expect(byDate.get('20260703')).toBe(3);
  });

  it('进度单调：emit 的 current 值严格递增', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ a: 1 }])
      .mockResolvedValueOnce([{ a: 2 }])
      .mockResolvedValueOnce([{ a: 3 }]);

    const ctx = makeCtx({ total: 3, grandTotal: 3 });
    await fetchByDates({
      apiName: 'test_api',
      fields: 'a',
      dates: ['20260701', '20260702', '20260703'],
      ctx,
      logger: makeLogger(),
      client: makeClient(query),
    });

    const currents = (ctx.emit as jest.Mock).mock.calls.map((c) => c[0].current as number);
    // Verify strictly increasing (each value >= previous)
    for (let i = 1; i < currents.length; i++) {
      expect(currents[i]).toBeGreaterThanOrEqual(currents[i - 1]);
    }
    // Also verify all current values are in [0, 3]
    for (const c of currents) {
      expect(c).toBeGreaterThanOrEqual(0);
      expect(c).toBeLessThanOrEqual(3);
    }
  });

  it('error 收集：某日期抛异常 → 该日期 rows 为空、errors 包含对应 msg，其他日期正常', async () => {
    const query = jest.fn()
      .mockResolvedValueOnce([{ a: 1 }])
      .mockRejectedValueOnce(new Error('网络超时'))
      .mockResolvedValueOnce([{ a: 3 }]);

    const logger = makeLogger();
    const result = await fetchByDates({
      apiName: 'test_api',
      fields: 'a',
      dates: ['20260701', '20260702', '20260703'],
      ctx: makeCtx(),
      logger,
      client: makeClient(query),
    });

    // All 3 dates should be present (failed one has empty rows)
    expect(result.rowsByDate).toHaveLength(3);
    const byDate = new Map(result.rowsByDate.map((r) => [r.date, r.rows.length]));
    expect(byDate.get('20260701')).toBe(1);
    expect(byDate.get('20260702')).toBe(0); // failed
    expect(byDate.get('20260703')).toBe(1);

    // errors has the failed date
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('[20260702]');
    expect(result.errors[0]).toContain('网络超时');

    // logger.error called for failed date
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it('abort：signal.aborted=true → rowsByDate 为空', async () => {
    const query = jest.fn().mockResolvedValue([{ a: 1 }]);

    const ac = new AbortController();
    ac.abort();

    const result = await fetchByDates({
      apiName: 'test_api',
      fields: 'a',
      dates: ['20260701', '20260702', '20260703'],
      ctx: makeCtx({ signal: ac.signal }),
      logger: makeLogger(),
      client: makeClient(query),
    });

    expect(result.rowsByDate).toEqual([]);
    expect(result.errors).toEqual([]);
    expect(query).not.toHaveBeenCalled();
  });

  it('0 行 warn：query 返回空数组时 logger.warn 被调用', async () => {
    const query = jest.fn().mockResolvedValue([]);

    const logger = makeLogger();
    const res = await fetchByDates({
      apiName: 'test_api',
      fields: 'a',
      dates: ['20260701'],
      ctx: makeCtx({ total: 1, grandTotal: 1 }),
      logger,
      client: makeClient(query),
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('test_api 20260701 返回空数据'),
    );
    expect(res.rowsByDate).toHaveLength(1);
  });

  it('截断 warn：行数 >= truncationThreshold 时 logger.warn 被调用', async () => {
    const rows = Array.from({ length: 6000 }, (_, i) => ({ a: i }));
    const query = jest.fn().mockResolvedValue(rows);

    const logger = makeLogger();
    const result = await fetchByDates({
      apiName: 'test_api',
      fields: 'a',
      dates: ['20260701'],
      ctx: makeCtx({ total: 1, grandTotal: 1 }),
      logger,
      client: makeClient(query),
      truncationThreshold: 6000,
    });

    expect(logger.warn).toHaveBeenCalledWith(
      expect.stringContaining('可能截断'),
    );
    expect(result.rowsByDate).toHaveLength(1);
    expect(result.rowsByDate[0].rows).toHaveLength(6000);
  });
});
