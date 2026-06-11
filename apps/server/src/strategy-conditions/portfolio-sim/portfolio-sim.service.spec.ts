/**
 * portfolio-sim.service.spec.ts
 *
 * 单测：DTO 校验（fail-fast 400）、触发互斥 409、anchorMode 多源拒绝、
 * 源 run fail-fast（不存在 / 非 completed / 零 trades）、fills 排序白名单拒绝、DELETE running 409。
 * 使用 mock Repository / DataSource / Runner，不连真 DB。
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { PortfolioSimService } from './portfolio-sim.service';
import { CreatePortfolioSimDto } from './dto/create-portfolio-sim.dto';
import { PortfolioSimConfig, PortfolioSimSource } from './portfolio-sim.types';
import { COST_PRESET_REALISTIC, COST_PRESET_ZERO } from './portfolio-sim.cost';

const UUID_A = '11111111-1111-4111-8111-111111111111';
const UUID_B = '22222222-2222-4222-8222-222222222222';

function source(over: Partial<PortfolioSimSource> = {}): PortfolioSimSource {
  return {
    runId: UUID_A,
    label: '策略A',
    positionRatio: 0.1,
    maxPositions: 5,
    exposureCap: 0.5,
    rankField: 'none',
    rankDir: 'asc',
    ...over,
  };
}

function config(over: Partial<PortfolioSimConfig> = {}): PortfolioSimConfig {
  return {
    sources: [source()],
    initialCapital: 1_000_000,
    cost: COST_PRESET_REALISTIC,
    anchorMode: false,
    ...over,
  };
}

function dto(over: Partial<CreatePortfolioSimDto> = {}): CreatePortfolioSimDto {
  return { name: '组合A', note: null, config: config(), ...over };
}

// ── mock 工厂 ──────────────────────────────────────────────────────────────

function makeRunRepo(entity?: Record<string, unknown>) {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => ({ id: 'new-id', ...(e as object) })),
    findOne: jest.fn(async () => entity ?? null),
    findAndCount: jest.fn(async () => [[], 0]),
    update: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
  };
}

function makeRepo() {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
    findAndCount: jest.fn(async () => [[], 0]),
    update: jest.fn(async () => undefined),
    remove: jest.fn(async () => undefined),
    delete: jest.fn(async () => undefined),
  };
}

/**
 * mock DataSource.query：按 SQL 关键字路由返回。
 * - 'FROM signal_test_run'   → runStatusRows
 * - 'FROM signal_test_trade' → tradeCountRows
 */
function makeDataSource(opts: {
  runStatusRows?: unknown[];
  tradeCountRows?: unknown[];
} = {}) {
  return {
    query: jest.fn(async (sql: string) => {
      if (sql.includes('signal_test_run')) {
        return opts.runStatusRows ?? [{ status: 'completed' }];
      }
      if (sql.includes('signal_test_trade')) {
        return opts.tradeCountRows ?? [{ cnt: '100' }];
      }
      return [];
    }),
  };
}

function makeRunner() {
  return { executeRun: jest.fn(async () => undefined) };
}

function makeService(opts: {
  runEntity?: Record<string, unknown>;
  runStatusRows?: unknown[];
  tradeCountRows?: unknown[];
} = {}) {
  const runRepo = makeRunRepo(opts.runEntity);
  const dailyRepo = makeRepo();
  const fillRepo = makeRepo();
  const ds = makeDataSource({
    runStatusRows: opts.runStatusRows,
    tradeCountRows: opts.tradeCountRows,
  });
  const runner = makeRunner();
  const svc = new PortfolioSimService(
    runRepo as any,
    dailyRepo as any,
    fillRepo as any,
    ds as any,
    runner as any,
  );
  return { svc, runRepo, dailyRepo, fillRepo, ds, runner };
}

// ── DTO 校验 ────────────────────────────────────────────────────────────────

describe('PortfolioSimService - create DTO 校验', () => {
  it('name 空 → 400', async () => {
    const { svc } = makeService();
    await expect(svc.create(dto({ name: '   ' }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('name >100 → 400', async () => {
    const { svc } = makeService();
    await expect(svc.create(dto({ name: 'x'.repeat(101) }))).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('sources 为空 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ sources: [] }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('sources >5 → 400', async () => {
    const { svc } = makeService();
    const six = Array.from({ length: 6 }, (_, i) =>
      source({ label: `L${i}`, runId: UUID_A }),
    );
    await expect(
      svc.create(dto({ config: config({ sources: six }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('label 重复 → 400', async () => {
    const { svc } = makeService();
    const two = [source({ label: '同名' }), source({ label: '同名', runId: UUID_B })];
    await expect(
      svc.create(dto({ config: config({ sources: two }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('runId 非 uuid → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ sources: [source({ runId: 'not-uuid' })] }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('positionRatio 越界（0 / >1）→ 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ sources: [source({ positionRatio: 0 })] }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(dto({ config: config({ sources: [source({ positionRatio: 1.5 })] }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('maxPositions=null 合法；非整数 / <1 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ sources: [source({ maxPositions: null })] }) })),
    ).resolves.toBeDefined();
    await expect(
      svc.create(dto({ config: config({ sources: [source({ maxPositions: 0 })] }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('exposureCap=null 合法；越界 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ sources: [source({ exposureCap: null })] }) })),
    ).resolves.toBeDefined();
    await expect(
      svc.create(dto({ config: config({ sources: [source({ exposureCap: 1.2 })] }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rankField / rankDir 非枚举 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ rankField: 'bogus' as any })] }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ rankDir: 'up' as any })] }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('initialCapital ≤0 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ initialCapital: 0 }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cost 负费率 → 400', async () => {
    const { svc } = makeService();
    const badCost = { ...COST_PRESET_REALISTIC, slippagePerSide: -0.001 };
    await expect(
      svc.create(dto({ config: config({ cost: badCost }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('anchorMode=true 且多源 → 400', async () => {
    const { svc } = makeService();
    const two = [source({ label: 'A' }), source({ label: 'B', runId: UUID_B })];
    await expect(
      svc.create(dto({ config: config({ sources: two, anchorMode: true }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('anchorMode=true 且单源 → 通过', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ sources: [source()], anchorMode: true, cost: COST_PRESET_ZERO }) }),
      ),
    ).resolves.toBeDefined();
  });

  it('合法 config → 通过并 save', async () => {
    const { svc, runRepo } = makeService();
    await expect(svc.create(dto())).resolves.toBeDefined();
    expect(runRepo.save).toHaveBeenCalled();
  });
});

// ── findOne / remove ──────────────────────────────────────────────────────

describe('PortfolioSimService - findOne / remove', () => {
  it('findOne 不存在 → 404', async () => {
    const { svc } = makeService();
    await expect(svc.findOne('missing')).rejects.toBeInstanceOf(NotFoundException);
  });

  it('remove running 中 → 409', async () => {
    const { svc } = makeService({ runEntity: { id: 'r1', status: 'running' } });
    await expect(svc.remove('r1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('remove 非 running → 调 repo.remove', async () => {
    const entity = { id: 'r1', status: 'success' };
    const { svc, runRepo } = makeService({ runEntity: entity });
    await svc.remove('r1');
    expect(runRepo.remove).toHaveBeenCalledWith(entity);
  });
});

// ── triggerRun ──────────────────────────────────────────────────────────────

describe('PortfolioSimService - triggerRun', () => {
  it('自身 running → 409（per-id 互斥）', async () => {
    const { svc } = makeService({
      runEntity: { id: 'r1', status: 'running', config: config() },
    });
    await expect(svc.triggerRun('r1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('源 run 不存在 → 400', async () => {
    const { svc } = makeService({
      runEntity: { id: 'r1', status: 'pending', config: config() },
      runStatusRows: [], // signal_test_run 查无
    });
    await expect(svc.triggerRun('r1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('源 run 非 completed → 400', async () => {
    const { svc } = makeService({
      runEntity: { id: 'r1', status: 'pending', config: config() },
      runStatusRows: [{ status: 'running' }],
    });
    await expect(svc.triggerRun('r1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('源 run trades=0 → 400', async () => {
    const { svc } = makeService({
      runEntity: { id: 'r1', status: 'pending', config: config() },
      runStatusRows: [{ status: 'completed' }],
      tradeCountRows: [{ cnt: '0' }],
    });
    await expect(svc.triggerRun('r1')).rejects.toBeInstanceOf(BadRequestException);
  });

  it('合法 → 置 running + 异步调 runner + 返回 runId', async () => {
    const { svc, runRepo, runner } = makeService({
      runEntity: { id: 'r1', status: 'success', config: config() },
      runStatusRows: [{ status: 'completed' }],
      tradeCountRows: [{ cnt: '50' }],
    });
    const res = await svc.triggerRun('r1');
    expect(res.runId).toBe('r1');
    expect(runRepo.update).toHaveBeenCalledWith(
      'r1',
      expect.objectContaining({ status: 'running' }),
    );
    await new Promise((r) => setImmediate(r));
    expect(runner.executeRun).toHaveBeenCalledWith('r1');
  });
});

// ── listFills 排序白名单 ──────────────────────────────────────────────────────

describe('PortfolioSimService - listFills 排序白名单', () => {
  it('未知 sortField → 400', async () => {
    const { svc } = makeService({ runEntity: { id: 'r1', status: 'success' } });
    await expect(
      svc.listFills('r1', 1, 50, { sortField: 'drop_table' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('合法 sortField → 调 findAndCount', async () => {
    const { svc, fillRepo } = makeService({ runEntity: { id: 'r1', status: 'success' } });
    await svc.listFills('r1', 1, 50, { sortField: 'realizedRetNet', sortOrder: 'desc' });
    expect(fillRepo.findAndCount).toHaveBeenCalled();
  });

  it('run 不存在 → 404', async () => {
    const { svc } = makeService(); // findOne 返回 null
    await expect(svc.listFills('missing', 1, 50, {})).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });
});
