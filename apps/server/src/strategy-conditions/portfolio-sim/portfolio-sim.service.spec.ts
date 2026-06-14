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
import {
  PortfolioSimConfig,
  PortfolioSimSource,
  SizingConfig,
  CircuitBreaker,
} from './portfolio-sim.types';
import { COST_PRESET_REALISTIC, COST_PRESET_ZERO } from './portfolio-sim.cost';
import { Logger } from '@nestjs/common';

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

// ── rankSpec 校验（多因子排序，spec 07 §1）──────────────────────────────────

function sizing(over: Partial<SizingConfig> = {}): SizingConfig {
  return {
    mode: 'signal_weighted',
    floorMult: 0.5,
    capMult: 1.5,
    kellyFraction: 0.5,
    kellyMaxMult: 1.0,
    ...over,
  };
}

function circuitBreaker(over: Partial<CircuitBreaker> = {}): CircuitBreaker {
  return {
    enableCooldown: true,
    consecutiveLossesThreshold: 3,
    baseCooldownDays: 3,
    maxCooldownDays: 10,
    extendOnLoss: 2,
    reduceOnProfit: 1,
    enableDrawdownHalt: true,
    drawdownHaltPct: 0.15,
    drawdownResumePct: 0.1,
    ...over,
  };
}

describe('PortfolioSimService - rankSpec 校验', () => {
  it('rankSpec.factors=[] → 通过（= none）', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ sources: [source({ rankSpec: { factors: [] } })] }) })),
    ).resolves.toBeDefined();
  });

  it('rankSpec 合法单因子 → 通过', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [
              source({ rankSpec: { factors: [{ factor: 'risk_reward', weight: 1, dir: 'desc' }] } }),
            ],
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('rankSpec 合法 composite（多因子）→ 通过', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [
              source({
                rankSpec: {
                  factors: [
                    { factor: 'pos_120', weight: 1, dir: 'asc' },
                    { factor: 'momentum_60', weight: 0.5, dir: 'desc' },
                  ],
                },
              }),
            ],
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('rankSpec.factors 非数组 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ rankSpec: { factors: 'x' as any } })] }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rankSpec 因子 KEY 非白名单 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [source({ rankSpec: { factors: [{ factor: 'bogus' as any, weight: 1, dir: 'asc' }] } })],
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rankSpec 因子 weight ≤0 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [source({ rankSpec: { factors: [{ factor: 'pos_120', weight: 0, dir: 'asc' }] } })],
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rankSpec 因子 dir 非枚举 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [source({ rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'up' as any }] } })],
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rankSpec 含 histAvailable=false 因子（ml_score）→ 通过但 logger.warn', async () => {
    const warnSpy = jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [source({ rankSpec: { factors: [{ factor: 'ml_score', weight: 1, dir: 'desc' }] } })],
          }),
        }),
      ),
    ).resolves.toBeDefined();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('ml_score'));
    warnSpy.mockRestore();
  });

  it('rankSpec 优先于 legacy rankField：rankField 非法但 rankSpec 合法 → 通过', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [
              source({
                rankField: 'bogus' as any,
                rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'asc' }] },
              }),
            ],
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('legacy rankField 扩为注册表全 9 因子（如 risk_reward）→ 通过', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ rankField: 'risk_reward' as any, rankDir: 'desc' })] }) }),
      ),
    ).resolves.toBeDefined();
  });
});

// ── sizing 校验（spec 07 §2）─────────────────────────────────────────────────

describe('PortfolioSimService - sizing 校验', () => {
  it('sizing 未提供 → 通过', async () => {
    const { svc } = makeService();
    await expect(svc.create(dto())).resolves.toBeDefined();
  });

  it('sizing.mode=fixed → 通过（不读 floor/cap/kelly）', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [source({ sizing: { mode: 'fixed', floorMult: -9, capMult: -9, kellyFraction: 9, kellyMaxMult: -9 } })],
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('sizing.mode 非白名单 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ sizing: sizing({ mode: 'bogus' as any }) })] }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('signal_weighted floorMult ≤0 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ sizing: sizing({ mode: 'signal_weighted', floorMult: 0 }) })] }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('signal_weighted capMult < floorMult → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [source({ sizing: sizing({ mode: 'signal_weighted', floorMult: 1.0, capMult: 0.5 }) })],
          }),
        }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('signal_weighted floor>0 且 cap≥floor → 通过', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [source({ sizing: sizing({ mode: 'signal_weighted', floorMult: 0.8, capMult: 0.8 }) })],
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('source_kelly kellyFraction 越界（0 / >1）→ 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ sizing: sizing({ mode: 'source_kelly', kellyFraction: 0 }) })] }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ sizing: sizing({ mode: 'source_kelly', kellyFraction: 1.5 }) })] }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('source_kelly kellyMaxMult ≤0 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ sources: [source({ sizing: sizing({ mode: 'source_kelly', kellyMaxMult: 0 }) })] }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('source_kelly kellyFraction∈(0,1] 且 kellyMaxMult>0 → 通过', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            sources: [source({ sizing: sizing({ mode: 'source_kelly', kellyFraction: 1.0, kellyMaxMult: 2.0 }) })],
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });
});

// ── circuitBreaker 校验（config 级，spec 07 §3）──────────────────────────────

describe('PortfolioSimService - circuitBreaker 校验', () => {
  it('circuitBreaker 未提供 → 通过', async () => {
    const { svc } = makeService();
    await expect(svc.create(dto())).resolves.toBeDefined();
  });

  it('全关（两开关 false）→ 通过（不校验阈值）', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({
          config: config({
            circuitBreaker: circuitBreaker({
              enableCooldown: false,
              enableDrawdownHalt: false,
              consecutiveLossesThreshold: -9,
              drawdownHaltPct: 9,
            }),
          }),
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('合法熔断（两开关 on）→ 通过', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ circuitBreaker: circuitBreaker() }) })),
    ).resolves.toBeDefined();
  });

  it('cooldown threshold <1 / 非整数 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ circuitBreaker: circuitBreaker({ consecutiveLossesThreshold: 0 }) }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(dto({ config: config({ circuitBreaker: circuitBreaker({ consecutiveLossesThreshold: 1.5 }) }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cooldown base>max → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ circuitBreaker: circuitBreaker({ baseCooldownDays: 10, maxCooldownDays: 5 }) }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cooldown base<0 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ circuitBreaker: circuitBreaker({ baseCooldownDays: -1 }) }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cooldown extendOnLoss <0 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ circuitBreaker: circuitBreaker({ extendOnLoss: -1 }) }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('cooldown reduceOnProfit <0 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ circuitBreaker: circuitBreaker({ reduceOnProfit: -1 }) }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drawdownHaltPct 越界（≤0 / ≥1）→ 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ circuitBreaker: circuitBreaker({ drawdownHaltPct: 0 }) }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      svc.create(
        dto({ config: config({ circuitBreaker: circuitBreaker({ drawdownHaltPct: 1, drawdownResumePct: 0.5 }) }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drawdownResumePct > haltPct → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ circuitBreaker: circuitBreaker({ drawdownHaltPct: 0.1, drawdownResumePct: 0.2 }) }) }),
      ),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drawdownResumePct <0 → 400', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(dto({ config: config({ circuitBreaker: circuitBreaker({ drawdownResumePct: -0.01 }) }) })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('drawdownResumePct=0 且 0<haltPct<1 → 通过（边界）', async () => {
    const { svc } = makeService();
    await expect(
      svc.create(
        dto({ config: config({ circuitBreaker: circuitBreaker({ drawdownHaltPct: 0.2, drawdownResumePct: 0 }) }) }),
      ),
    ).resolves.toBeDefined();
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
