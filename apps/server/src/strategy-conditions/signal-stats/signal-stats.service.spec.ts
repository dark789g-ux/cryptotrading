/**
 * signal-stats.service.spec.ts
 *
 * 单测：DTO 校验（fail-fast） + 区间越界 + 模式必填 + findAll latestRun + getRetHistogram。
 * 使用 mock Repository / DataSource，不连真 DB。
 */
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { SignalStatsService } from './signal-stats.service';
import { CreateSignalTestDto } from './dto/create-signal-test.dto';

// ── mock 工厂 ──────────────────────────────────────────────────────────────

/** 构造一个可链式调用 createQueryBuilder 的 mock，getMany/getRawMany 返回指定值。 */
function makeQueryBuilderMock(getManyResult: unknown[] = [], getRawManyResult: unknown[] = []) {
  const qb: Record<string, jest.Mock> = {};
  const chain = () => qb;
  qb.distinctOn = jest.fn(chain);
  qb.orderBy = jest.fn(chain);
  qb.addOrderBy = jest.fn(chain);
  qb.select = jest.fn(chain);
  qb.where = jest.fn(chain);
  qb.getMany = jest.fn(async () => getManyResult);
  qb.getRawMany = jest.fn(async () => getRawManyResult);
  return qb;
}

function makeMockRepo(entity?: Record<string, unknown>, qbMock?: Record<string, jest.Mock>) {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
    findOne: jest.fn(async () => entity ?? null),
    find: jest.fn(async () => []),
    remove: jest.fn(async () => undefined),
    findAndCount: jest.fn(async () => [[], 0]),
    createQueryBuilder: jest.fn(() => qbMock ?? makeQueryBuilderMock()),
  };
}

function makeMockDataSource(rows?: unknown[]) {
  return {
    query: jest.fn(async () =>
      rows ?? [{ minDate: '20100101', maxDate: '20301231' }],
    ),
  };
}

function makeMockRunner() {
  return { executeRun: jest.fn(async () => undefined) };
}

function buildValidDto(overrides: Partial<CreateSignalTestDto> = {}): CreateSignalTestDto {
  return {
    name: '测试方案',
    buyConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
    exitMode: 'fixed_n',
    horizonN: 5,
    universe: { type: 'all' },
    dateStart: '20240101',
    dateEnd: '20240630',
    ...overrides,
  };
}

function makeService(
  testEntity?: Record<string, unknown>,
  calRows?: unknown[],
): SignalStatsService {
  const testRepo = makeMockRepo(testEntity);
  const runRepo = makeMockRepo();
  const tradeRepo = makeMockRepo();
  const dataSource = makeMockDataSource(calRows);
  const runner = makeMockRunner();
  return new SignalStatsService(
    testRepo as any,
    runRepo as any,
    tradeRepo as any,
    dataSource as any,
    runner as any,
  );
}

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe('SignalStatsService - DTO validation', () => {
  describe('buyConditions', () => {
    it('buyConditions 为空数组时抛 400', async () => {
      const svc = makeService();
      await expect(svc.create(buildValidDto({ buyConditions: [] }))).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });

  describe('exitMode=fixed_n', () => {
    it('horizonN 未填时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ exitMode: 'fixed_n', horizonN: undefined })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('horizonN=0 时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ exitMode: 'fixed_n', horizonN: 0 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('horizonN=1 通过校验', async () => {
      const svc = makeService();
      await expect(svc.create(buildValidDto({ horizonN: 1 }))).resolves.toBeDefined();
    });
  });

  describe('exitMode=strategy', () => {
    const baseStrategy: Partial<CreateSignalTestDto> = {
      exitMode: 'strategy',
      exitConditions: [{ field: 'macd_hist', operator: 'lt', value: 0 }],
      maxHold: 10,
    };

    it('exitConditions 为空时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ ...baseStrategy, exitConditions: [] })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maxHold 未填时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ ...baseStrategy, maxHold: undefined })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maxHold=0 时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ ...baseStrategy, maxHold: 0 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('合法 strategy 参数通过', async () => {
      const svc = makeService();
      await expect(svc.create(buildValidDto({ ...baseStrategy }))).resolves.toBeDefined();
    });
  });

  describe('universe', () => {
    it('type=list 且 tsCodes 为空时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ universe: { type: 'list', tsCodes: [] } })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('type=list 且 tsCodes 非空时通过', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ universe: { type: 'list', tsCodes: ['600519.SH'] } })),
      ).resolves.toBeDefined();
    });
  });

  describe('日期校验', () => {
    it('dateStart > dateEnd 时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ dateStart: '20240701', dateEnd: '20240601' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('dateStart 早于 trade_cal 最小日期时抛 400', async () => {
      // 模拟 trade_cal 范围 20200101 ~ 20301231
      const svc = makeService(undefined, [{ minDate: '20200101', maxDate: '20301231' }]);
      await expect(
        svc.create(buildValidDto({ dateStart: '20100101', dateEnd: '20240630' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('dateEnd 晚于 trade_cal 最大日期时抛 400', async () => {
      const svc = makeService(undefined, [{ minDate: '20100101', maxDate: '20251231' }]);
      await expect(
        svc.create(buildValidDto({ dateStart: '20240101', dateEnd: '20260101' })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('合法日期区间通过', async () => {
      const svc = makeService(undefined, [{ minDate: '20100101', maxDate: '20301231' }]);
      await expect(svc.create(buildValidDto())).resolves.toBeDefined();
    });
  });
});

describe('SignalStatsService - CRUD', () => {
  it('findOne 不存在时抛 NotFoundException', async () => {
    const testRepo = makeMockRepo(undefined); // findOne 返回 null
    const svc = new SignalStatsService(
      testRepo as any,
      makeMockRepo() as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );
    await expect(svc.findOne('non-existent-id')).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('SignalStatsService - triggerRun', () => {
  it('已有 running 状态时抛 ConflictException', async () => {
    const testEntity = { id: 'test-1', name: 'T', buyConditions: [], exitMode: 'fixed_n', horizonN: 5, exitConditions: null, maxHold: null, universe: { type: 'all' }, dateStart: '20240101', dateEnd: '20240630' };
    const testRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (e: unknown) => e),
      findOne: jest.fn(async () => testEntity),
      find: jest.fn(async () => []),
      remove: jest.fn(),
      findAndCount: jest.fn(async () => [[], 0]),
      createQueryBuilder: jest.fn(() => makeQueryBuilderMock()),
    };
    const runRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (e: unknown) => e),
      // findOne 返回已有 running run
      findOne: jest.fn(async () => ({ id: 'run-existing', status: 'running' })),
      find: jest.fn(async () => []),
      remove: jest.fn(),
      findAndCount: jest.fn(async () => [[], 0]),
      createQueryBuilder: jest.fn(() => makeQueryBuilderMock()),
    };
    const svc = new SignalStatsService(
      testRepo as any,
      runRepo as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );
    await expect(svc.triggerRun('test-1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('无 running run 时创建新 run 并返回 runId', async () => {
    const testEntity = { id: 'test-1', name: 'T', buyConditions: [{ field: 'f', operator: 'gt', value: 0 }], exitMode: 'fixed_n', horizonN: 5, exitConditions: null, maxHold: null, universe: { type: 'all' }, dateStart: '20240101', dateEnd: '20240630' };
    const testRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (e: unknown) => e),
      findOne: jest.fn(async () => testEntity),
      find: jest.fn(async () => []),
      remove: jest.fn(),
      findAndCount: jest.fn(async () => [[], 0]),
      createQueryBuilder: jest.fn(() => makeQueryBuilderMock()),
    };
    const savedRun = { id: 'run-new', status: 'running', testId: 'test-1' };
    const runRepo = {
      create: jest.fn(() => savedRun),
      save: jest.fn(async () => savedRun),
      findOne: jest.fn(async () => null), // 无 running run
      find: jest.fn(async () => []),
      remove: jest.fn(),
      findAndCount: jest.fn(async () => [[], 0]),
      createQueryBuilder: jest.fn(() => makeQueryBuilderMock()),
    };
    const runner = makeMockRunner();
    const svc = new SignalStatsService(
      testRepo as any,
      runRepo as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      runner as any,
    );
    const result = await svc.triggerRun('test-1');
    expect(result.runId).toBe('run-new');
    // runner 应被异步调用（不等待）
    await new Promise((r) => setImmediate(r));
    expect(runner.executeRun).toHaveBeenCalledWith(testEntity, 'run-new');
  });
});

// ── findAll with latestRun ────────────────────────────────────────────────

describe('SignalStatsService - findAll with latestRun', () => {
  const testA = { id: 'test-a', name: 'A', createdAt: new Date('2024-01-01') };
  const testB = { id: 'test-b', name: 'B', createdAt: new Date('2024-01-02') };
  const runForA = { id: 'run-a1', testId: 'test-a', status: 'completed', createdAt: new Date('2024-02-01') };

  it('有 run 的 test 附带 latestRun', async () => {
    // testRepo.find 返回 [testA, testB]
    // runRepo.createQueryBuilder.getMany 返回 [runForA]（只有 testA 有 run）
    const runQb = makeQueryBuilderMock([runForA]);
    const testRepo = {
      ...makeMockRepo(),
      find: jest.fn(async () => [testA, testB]),
    };
    const runRepo = {
      ...makeMockRepo(),
      createQueryBuilder: jest.fn(() => runQb),
    };
    const svc = new SignalStatsService(
      testRepo as any,
      runRepo as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );

    const result = await svc.findAll();
    expect(result).toHaveLength(2);

    const withRun = result.find((r) => r.id === 'test-a');
    expect(withRun?.latestRun).toEqual(runForA);

    const withoutRun = result.find((r) => r.id === 'test-b');
    expect(withoutRun?.latestRun).toBeNull();
  });

  it('无任何 run 时每个 test.latestRun 均为 null', async () => {
    const runQb = makeQueryBuilderMock([]); // 无 run
    const testRepo = {
      ...makeMockRepo(),
      find: jest.fn(async () => [testA, testB]),
    };
    const runRepo = {
      ...makeMockRepo(),
      createQueryBuilder: jest.fn(() => runQb),
    };
    const svc = new SignalStatsService(
      testRepo as any,
      runRepo as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );

    const result = await svc.findAll();
    for (const item of result) {
      expect(item.latestRun).toBeNull();
    }
  });

  it('无方案时返回空数组', async () => {
    const runQb = makeQueryBuilderMock([]);
    const testRepo = {
      ...makeMockRepo(),
      find: jest.fn(async () => []),
    };
    const runRepo = {
      ...makeMockRepo(),
      createQueryBuilder: jest.fn(() => runQb),
    };
    const svc = new SignalStatsService(
      testRepo as any,
      runRepo as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );

    const result = await svc.findAll();
    expect(result).toEqual([]);
  });
});

// ── getRetHistogram ───────────────────────────────────────────────────────

describe('SignalStatsService - getRetHistogram', () => {
  it('run 不存在时抛 NotFoundException', async () => {
    const runRepo = {
      ...makeMockRepo(undefined), // findOne 返回 null
      createQueryBuilder: jest.fn(() => makeQueryBuilderMock()),
    };
    const svc = new SignalStatsService(
      makeMockRepo() as any,
      runRepo as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );
    await expect(svc.getRetHistogram('non-existent-run', 25)).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('run 存在但无明细时返回 bins:[], sampleCount:0', async () => {
    const existingRun = { id: 'run-1', testId: 'test-1', status: 'completed' };
    // tradeRepo.createQueryBuilder.getRawMany 返回空数组
    const tradeQb = makeQueryBuilderMock([], []);
    const runRepo = {
      ...makeMockRepo(existingRun as any),
      createQueryBuilder: jest.fn(() => makeQueryBuilderMock()),
    };
    const tradeRepo = {
      ...makeMockRepo(),
      createQueryBuilder: jest.fn(() => tradeQb),
    };
    const svc = new SignalStatsService(
      makeMockRepo() as any,
      runRepo as any,
      tradeRepo as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );
    const result = await svc.getRetHistogram('run-1', 25);
    expect(result.bins).toEqual([]);
    expect(result.sampleCount).toBe(0);
    expect(result.binWidth).toBeNull();
  });

  it('run 存在且有明细时返回正确 sampleCount', async () => {
    const existingRun = { id: 'run-2', testId: 'test-1', status: 'completed' };
    const rawRows = [
      { ret: '0.05' },
      { ret: '-0.03' },
      { ret: '0.08' },
    ];
    const tradeQb = makeQueryBuilderMock([], rawRows);
    const runRepo = {
      ...makeMockRepo(existingRun as any),
      createQueryBuilder: jest.fn(() => makeQueryBuilderMock()),
    };
    const tradeRepo = {
      ...makeMockRepo(),
      createQueryBuilder: jest.fn(() => tradeQb),
    };
    const svc = new SignalStatsService(
      makeMockRepo() as any,
      runRepo as any,
      tradeRepo as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );
    const result = await svc.getRetHistogram('run-2', 25);
    expect(result.runId).toBe('run-2');
    expect(result.sampleCount).toBe(3);
    // 总 count 守恒
    const total = result.bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(3);
  });
});
