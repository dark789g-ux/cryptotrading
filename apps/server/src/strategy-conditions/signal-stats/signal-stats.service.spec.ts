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
  const symbolRepo = makeMockRepo();
  const dataSource = makeMockDataSource(calRows);
  const runner = makeMockRunner();
  return new SignalStatsService(
    testRepo as any,
    runRepo as any,
    tradeRepo as any,
    symbolRepo as any,
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

  describe('exitMode=trailing_lock', () => {
    const baseTrailingLock: Partial<CreateSignalTestDto> = {
      exitMode: 'trailing_lock',
      // 复用 maxHold 字段、可选；不带 horizonN / exitConditions。
      horizonN: undefined,
    };

    it('留空 maxHold（无硬上限）通过校验', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ ...baseTrailingLock, maxHold: undefined })),
      ).resolves.toBeDefined();
    });

    it('合法 maxHold=10 通过校验', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ ...baseTrailingLock, maxHold: 10 })),
      ).resolves.toBeDefined();
    });

    it('maxHold=0 时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ ...baseTrailingLock, maxHold: 0 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('maxHold 非整数（1.5）时抛 400', async () => {
      const svc = makeService();
      await expect(
        svc.create(buildValidDto({ ...baseTrailingLock, maxHold: 1.5 })),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('不强制 horizonN / exitConditions（均缺省仍通过）', async () => {
      const svc = makeService();
      await expect(
        svc.create(
          buildValidDto({
            ...baseTrailingLock,
            maxHold: undefined,
            horizonN: undefined,
            exitConditions: undefined,
          }),
        ),
      ).resolves.toBeDefined();
    });

    // ── band_lock 4 参数校验 ────────────────────────────────────────────────
    describe('band_lock 参数校验', () => {
      it('4 参数全缺省通过校验', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ ...baseTrailingLock })),
        ).resolves.toBeDefined();
      });

      it('合法 stopRatio=0.95 通过', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ ...baseTrailingLock, stopRatio: 0.95 })),
        ).resolves.toBeDefined();
      });

      it('stopRatio 量化后越上界（>1.0）抛 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ ...baseTrailingLock, stopRatio: 1.0005 })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('stopRatio 量化后为 0（<0.001）抛 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ ...baseTrailingLock, stopRatio: 0.0004 })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('stopRatio=1.0（量化 NNNN=1000，上界含）通过', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ ...baseTrailingLock, stopRatio: 1.0 })),
        ).resolves.toBeDefined();
      });

      it('floorRatio=1.5（锁盈，>1 合法）通过', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ ...baseTrailingLock, floorRatio: 1.5 })),
        ).resolves.toBeDefined();
      });

      it('floorRatio 量化后越上界（>9.999）抛 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ ...baseTrailingLock, floorRatio: 10 })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('floorRatio 量化后为 0（<0.001）抛 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ ...baseTrailingLock, floorRatio: 0.0004 })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('floorEnabled 非布尔抛 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(
            buildValidDto({ ...baseTrailingLock, floorEnabled: 'true' as unknown as boolean }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('ma5RequireDown 非布尔抛 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(
            buildValidDto({ ...baseTrailingLock, ma5RequireDown: 1 as unknown as boolean }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
    });

    // ── 非 trailing_lock 模式误送 4 参数 → 400 ───────────────────────────────
    describe('非 trailing_lock 模式误送 band_lock 参数 → 400', () => {
      it('fixed_n 误送 stopRatio → 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ exitMode: 'fixed_n', horizonN: 5, stopRatio: 0.99 })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('strategy 误送 floorEnabled → 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(
            buildValidDto({
              exitMode: 'strategy',
              exitConditions: [{ field: 'macd_hist', operator: 'lt', value: 0 }],
              maxHold: 10,
              floorEnabled: false,
            }),
          ),
        ).rejects.toBeInstanceOf(BadRequestException);
      });

      it('fixed_n 误送 ma5RequireDown → 400', async () => {
        const svc = makeService();
        await expect(
          svc.create(buildValidDto({ exitMode: 'fixed_n', horizonN: 5, ma5RequireDown: true })),
        ).rejects.toBeInstanceOf(BadRequestException);
      });
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

// ── band_lock 持久化（create → testRepo.create payload）────────────────────

describe('SignalStatsService - band_lock 持久化', () => {
  /** 构造 service 并暴露 testRepo，便于断言 create 收到的 payload。 */
  function makeServiceWithTestRepo() {
    const testRepo = makeMockRepo();
    const svc = new SignalStatsService(
      testRepo as any,
      makeMockRepo() as any,
      makeMockRepo() as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );
    return { svc, testRepo };
  }

  const baseTL: Partial<CreateSignalTestDto> = {
    exitMode: 'trailing_lock',
    horizonN: undefined,
  };

  it('trailing_lock 4 参数全默认 → bandLockParams 存 null（零漂移）', async () => {
    const { svc, testRepo } = makeServiceWithTestRepo();
    await svc.create(buildValidDto({ ...baseTL }));
    const payload = testRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.bandLockParams).toBeNull();
  });

  it('显式传入全默认值（0.999/0.999/true/true）→ 仍存 null', async () => {
    const { svc, testRepo } = makeServiceWithTestRepo();
    await svc.create(
      buildValidDto({
        ...baseTL,
        stopRatio: 0.999,
        floorRatio: 0.999,
        floorEnabled: true,
        ma5RequireDown: true,
      }),
    );
    const payload = testRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.bandLockParams).toBeNull();
  });

  it('任一非默认 → 存量化后的完整 4 字段对象', async () => {
    const { svc, testRepo } = makeServiceWithTestRepo();
    // stopRatio 量化：0.9505 → round(950.5)=951 → 0.951（round-half-up）
    await svc.create(buildValidDto({ ...baseTL, stopRatio: 0.9505 }));
    const payload = testRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.bandLockParams).toEqual({
      stopRatio: 0.951,
      floorRatio: 0.999, // 其余补默认
      floorEnabled: true,
      ma5RequireDown: true,
    });
  });

  it('floorEnabled=false（非默认）→ 存完整对象', async () => {
    const { svc, testRepo } = makeServiceWithTestRepo();
    await svc.create(buildValidDto({ ...baseTL, floorEnabled: false }));
    const payload = testRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.bandLockParams).toEqual({
      stopRatio: 0.999,
      floorRatio: 0.999,
      floorEnabled: false,
      ma5RequireDown: true,
    });
  });

  it('非 trailing_lock 模式（fixed_n）→ bandLockParams 始终 null', async () => {
    const { svc, testRepo } = makeServiceWithTestRepo();
    await svc.create(buildValidDto({ exitMode: 'fixed_n', horizonN: 5 }));
    const payload = testRepo.create.mock.calls[0][0] as Record<string, unknown>;
    expect(payload.bandLockParams).toBeNull();
  });
});

// ── band_lock update(PUT) 路径持久化 ───────────────────────────────────────

describe('SignalStatsService - band_lock update(PUT)', () => {
  /**
   * 构造一个 update 场景的 service：testRepo.findOne 返回给定 entity（含 bandLockParams），
   * 暴露 testRepo 便于断言 save 收到的合并结果。
   */
  function makeUpdateService(entity: Record<string, unknown>) {
    const testRepo = makeMockRepo(entity);
    const svc = new SignalStatsService(
      testRepo as any,
      makeMockRepo() as any,
      makeMockRepo() as any,
      makeMockRepo() as any,
      makeMockDataSource() as any,
      makeMockRunner() as any,
    );
    return { svc, testRepo };
  }

  /** 一个 bandLockParams 非默认的 trailing_lock 存量方案。 */
  function nonDefaultTrailingLockEntity(): Record<string, unknown> {
    return {
      id: 'test-tl',
      name: '波段锁',
      buyConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
      exitMode: 'trailing_lock',
      horizonN: null,
      exitConditions: null,
      maxHold: null,
      bandLockParams: {
        stopRatio: 0.95,
        floorRatio: 0.999,
        floorEnabled: false, // 非默认布尔，验证不被 ??/|| 吞
        ma5RequireDown: true,
      },
      universe: { type: 'all' },
      dateStart: '20240101',
      dateEnd: '20240630',
    };
  }

  it('[回归] 非默认 trailing_lock 方案 PUT 切 fixed_n → 不报错且 bandLockParams 置 null', async () => {
    const { svc, testRepo } = makeUpdateService(nonDefaultTrailingLockEntity());
    // 仅切模式 + 提供 fixed_n 必填项，不带任何 band_lock 参数（用户本意：抛弃 band_lock）
    const saved = (await svc.update('test-tl', {
      exitMode: 'fixed_n',
      horizonN: 5,
    })) as unknown as Record<string, unknown>;
    expect(saved.exitMode).toBe('fixed_n');
    expect(saved.bandLockParams).toBeNull();
    // save 收到的 payload 同样应为 null
    const savedArg = testRepo.save.mock.calls[0][0] as unknown as Record<string, unknown>;
    expect(savedArg.bandLockParams).toBeNull();
  });

  it('[回归] 非默认 trailing_lock 方案 PUT 切 strategy → 不报错且 bandLockParams 置 null', async () => {
    const { svc } = makeUpdateService(nonDefaultTrailingLockEntity());
    const saved = (await svc.update('test-tl', {
      exitMode: 'strategy',
      exitConditions: [{ field: 'macd_hist', operator: 'lt', value: 0 }],
      maxHold: 10,
    })) as unknown as Record<string, unknown>;
    expect(saved.exitMode).toBe('strategy');
    expect(saved.bandLockParams).toBeNull();
  });

  it('trailing_lock → trailing_lock 更新单个 band_lock 参数，其余从存量保留（含 floorEnabled=false）', async () => {
    const { svc } = makeUpdateService(nonDefaultTrailingLockEntity());
    // 只改 stopRatio，floorEnabled=false 应跨更新保留（不被 ?? 吞回 true）
    const saved = (await svc.update('test-tl', {
      stopRatio: 0.9,
    })) as unknown as Record<string, unknown>;
    expect(saved.bandLockParams).toEqual({
      stopRatio: 0.9,
      floorRatio: 0.999,
      floorEnabled: false, // 存量 false 保留
      ma5RequireDown: true,
    });
  });

  it('trailing_lock → trailing_lock 显式更新 floorEnabled=false（dto 显式 false 不被吞）', async () => {
    // 存量 floorEnabled=true，PUT 显式置 false
    const entity = nonDefaultTrailingLockEntity();
    (entity.bandLockParams as Record<string, unknown>).floorEnabled = true;
    const { svc } = makeUpdateService(entity);
    const saved = (await svc.update('test-tl', {
      floorEnabled: false,
    })) as unknown as Record<string, unknown>;
    expect((saved.bandLockParams as Record<string, unknown>).floorEnabled).toBe(false);
  });

  it('trailing_lock 把 band_lock 参数改回全默认 → bandLockParams 回 null', async () => {
    const { svc } = makeUpdateService(nonDefaultTrailingLockEntity());
    // 显式把 4 参数全部送回默认值
    const saved = (await svc.update('test-tl', {
      stopRatio: 0.999,
      floorRatio: 0.999,
      floorEnabled: true,
      ma5RequireDown: true,
    })) as unknown as Record<string, unknown>;
    expect(saved.bandLockParams).toBeNull();
  });

  it('fixed_n 存量方案 PUT 切 trailing_lock 并带 band_lock 参数 → 落库量化对象', async () => {
    const entity = {
      id: 'test-fn',
      name: '固定N',
      buyConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
      exitMode: 'fixed_n',
      horizonN: 5,
      exitConditions: null,
      maxHold: null,
      bandLockParams: null,
      universe: { type: 'all' },
      dateStart: '20240101',
      dateEnd: '20240630',
    };
    const { svc } = makeUpdateService(entity);
    const saved = (await svc.update('test-fn', {
      exitMode: 'trailing_lock',
      stopRatio: 0.95,
    })) as unknown as Record<string, unknown>;
    expect(saved.exitMode).toBe('trailing_lock');
    expect(saved.bandLockParams).toEqual({
      stopRatio: 0.95,
      floorRatio: 0.999,
      floorEnabled: true,
      ma5RequireDown: true,
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
      makeMockRepo() as any,
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
      makeMockRepo() as any,
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
