/**
 * signal-stats.service.spec.ts
 *
 * 单测：DTO 校验（fail-fast） + 区间越界 + 模式必填。
 * 使用 mock Repository / DataSource，不连真 DB。
 */
import { BadRequestException, NotFoundException, ConflictException } from '@nestjs/common';
import { SignalStatsService } from './signal-stats.service';
import { CreateSignalTestDto } from './dto/create-signal-test.dto';

// ── mock 工厂 ──────────────────────────────────────────────────────────────

function makeMockRepo(entity?: Record<string, unknown>) {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
    findOne: jest.fn(async () => entity ?? null),
    find: jest.fn(async () => []),
    remove: jest.fn(async () => undefined),
    findAndCount: jest.fn(async () => [[], 0]),
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
    };
    const runRepo = {
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (e: unknown) => e),
      // findOne 返回已有 running run
      findOne: jest.fn(async () => ({ id: 'run-existing', status: 'running' })),
      find: jest.fn(async () => []),
      remove: jest.fn(),
      findAndCount: jest.fn(async () => [[], 0]),
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
    };
    const savedRun = { id: 'run-new', status: 'running', testId: 'test-1' };
    const runRepo = {
      create: jest.fn(() => savedRun),
      save: jest.fn(async () => savedRun),
      findOne: jest.fn(async () => null), // 无 running run
      find: jest.fn(async () => []),
      remove: jest.fn(),
      findAndCount: jest.fn(async () => [[], 0]),
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
