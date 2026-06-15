/**
 * signal-stats.backtest-config.spec.ts
 *
 * 单测：CreateSignalTestDto.backtestConfig 校验（spec 04 §4.6）。
 * 复用 portfolio-sim 校验语义，落到扁平单源形。mock Repository / DataSource，不连真 DB。
 */
import { BadRequestException } from '@nestjs/common';
import { SignalStatsService } from './signal-stats.service';
import { CreateSignalTestDto } from './dto/create-signal-test.dto';
import { SignalTestBacktestConfig } from '../../entities/strategy/signal-test.entity';

function makeMockRepo() {
  return {
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
    findOne: jest.fn(async () => null),
    find: jest.fn(async () => []),
    remove: jest.fn(async () => undefined),
    findAndCount: jest.fn(async () => [[], 0]),
    createQueryBuilder: jest.fn(() => ({
      distinctOn: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      addOrderBy: jest.fn().mockReturnThis(),
      select: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      getMany: jest.fn(async () => []),
      getRawMany: jest.fn(async () => []),
    })),
  };
}

function makeMockDataSource() {
  return {
    query: jest.fn(async () => [{ minDate: '20100101', maxDate: '20301231' }]),
  };
}

function makeService(): SignalStatsService {
  return new SignalStatsService(
    makeMockRepo() as any, // testRepo
    makeMockRepo() as any, // runRepo
    makeMockRepo() as any, // tradeRepo
    makeMockRepo() as any, // equityRepo
    makeMockRepo() as any, // symbolRepo
    makeMockDataSource() as any,
    { executeRun: jest.fn(async () => undefined) } as any,
  );
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

function buildDto(
  backtestConfig?: SignalTestBacktestConfig | null,
): CreateSignalTestDto {
  return {
    name: '测试方案',
    buyConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
    exitMode: 'fixed_n',
    horizonN: 5,
    universe: { type: 'all' },
    dateStart: '20240101',
    dateEnd: '20240630',
    ...(backtestConfig !== undefined ? { backtestConfig } : {}),
  };
}

describe('SignalStatsService - backtestConfig 校验', () => {
  describe('缺省 / null（不跑回测）', () => {
    it('不带 backtestConfig → 通过（零漂移）', async () => {
      await expect(makeService().create(buildDto())).resolves.toBeDefined();
    });

    it('backtestConfig=null → 通过', async () => {
      await expect(makeService().create(buildDto(null))).resolves.toBeDefined();
    });
  });

  describe('合法配置通过', () => {
    it('完整合法 backtestConfig（fixed / rankSpec=[] / cb=null）通过', async () => {
      await expect(makeService().create(buildDto(makeBacktestConfig()))).resolves.toBeDefined();
    });

    it('anchorMode=true（约束/费率交给适配层旁路，dto 仅校验形态）通过', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ anchorMode: true }))),
      ).resolves.toBeDefined();
    });

    it('maxPositions=null / exposureCap=null 通过', async () => {
      await expect(
        makeService().create(
          buildDto(makeBacktestConfig({ maxPositions: null, exposureCap: null })),
        ),
      ).resolves.toBeDefined();
    });

    it('rankSpec 含合法因子（pos_120 desc weight=2）通过', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              rankSpec: { factors: [{ factor: 'pos_120', weight: 2, dir: 'desc' }] },
            }),
          ),
        ),
      ).resolves.toBeDefined();
    });

    it('sizing=signal_weighted（capMult>=floorMult>0）通过', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              sizing: { mode: 'signal_weighted', floorMult: 0.5, capMult: 1.5, kellyFraction: 0.5, kellyMaxMult: 1 },
            }),
          ),
        ),
      ).resolves.toBeDefined();
    });

    it('circuitBreaker 双触发字段齐全（resumePct<=haltPct）通过', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              circuitBreaker: {
                enableCooldown: true,
                consecutiveLossesThreshold: 3,
                baseCooldownDays: 2,
                maxCooldownDays: 5,
                extendOnLoss: 1,
                reduceOnProfit: 1,
                enableDrawdownHalt: true,
                drawdownHaltPct: 0.15,
                drawdownResumePct: 0.1,
              },
            }),
          ),
        ),
      ).resolves.toBeDefined();
    });
  });

  describe('initialCapital', () => {
    it('initialCapital<=0 抛 400', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ initialCapital: 0 }))),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('positionRatio 区间 (0,1]', () => {
    it('positionRatio=0 抛 400', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ positionRatio: 0 }))),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('positionRatio>1 抛 400', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ positionRatio: 1.1 }))),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('positionRatio=1 通过', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ positionRatio: 1 }))),
      ).resolves.toBeDefined();
    });
  });

  describe('maxPositions', () => {
    it('maxPositions=0 抛 400（非 null 须 ≥1 整数）', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ maxPositions: 0 }))),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('maxPositions=2.5（非整数）抛 400', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ maxPositions: 2.5 }))),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('exposureCap 区间 (0,1] 或 null', () => {
    it('exposureCap=0 抛 400', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ exposureCap: 0 }))),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('exposureCap>1 抛 400', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ exposureCap: 1.2 }))),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('cost 费率 ≥0', () => {
    it('某费率为负抛 400', async () => {
      const bc = makeBacktestConfig();
      bc.cost.commissionPerSide = -0.001;
      await expect(makeService().create(buildDto(bc))).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('sizing 模式枚举', () => {
    it('mode 非法（unknown）抛 400', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              sizing: { mode: 'unknown' as any, floorMult: 0.5, capMult: 1.5, kellyFraction: 0.5, kellyMaxMult: 1 },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('signal_weighted 但 capMult<floorMult 抛 400', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              sizing: { mode: 'signal_weighted', floorMult: 1.5, capMult: 0.5, kellyFraction: 0.5, kellyMaxMult: 1 },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('source_kelly 但 kellyFraction>1 抛 400', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              sizing: { mode: 'source_kelly', floorMult: 0.5, capMult: 1.5, kellyFraction: 1.5, kellyMaxMult: 1 },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('rankSpec.factors 白名单', () => {
    it('factor 非白名单抛 400', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              rankSpec: { factors: [{ factor: 'not_a_factor' as any, weight: 1, dir: 'asc' }] },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('weight<=0 抛 400', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              rankSpec: { factors: [{ factor: 'pos_120', weight: 0, dir: 'asc' }] },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
    it('dir 非法抛 400', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'sideways' as any }] },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('circuitBreaker', () => {
    it('drawdownResumePct>haltPct 抛 400', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              circuitBreaker: {
                enableCooldown: false,
                consecutiveLossesThreshold: 3,
                baseCooldownDays: 2,
                maxCooldownDays: 5,
                extendOnLoss: 1,
                reduceOnProfit: 1,
                enableDrawdownHalt: true,
                drawdownHaltPct: 0.1,
                drawdownResumePct: 0.2,
              },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('enableCooldown 但 consecutiveLossesThreshold<1 抛 400', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              circuitBreaker: {
                enableCooldown: true,
                consecutiveLossesThreshold: 0,
                baseCooldownDays: 2,
                maxCooldownDays: 5,
                extendOnLoss: 1,
                reduceOnProfit: 1,
                enableDrawdownHalt: false,
                drawdownHaltPct: 0.15,
                drawdownResumePct: 0.1,
              },
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });

  describe('regimes（validateRegimes 接线）', () => {
    const okRegimes = [
      {
        conditions: [
          { field: 'oamv_macd', operator: 'gt' as const, value: 0 },
          { field: 'oamv_dif', operator: 'gt' as const, value: 0 },
        ],
        maxPositions: 2,
        positionRatio: 0.45,
      },
    ];

    it('regimes 缺省 → 通过（零漂移）', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig())),
      ).resolves.toBeDefined();
    });

    it('合法 regimes → 通过', async () => {
      await expect(
        makeService().create(buildDto(makeBacktestConfig({ regimes: okRegimes }))),
      ).resolves.toBeDefined();
    });

    it('非法 operator（cross_above）regimes → 400（validator 已接线）', async () => {
      await expect(
        makeService().create(
          buildDto(
            makeBacktestConfig({
              regimes: [
                {
                  conditions: [{ field: 'oamv_dif', operator: 'cross_above', value: 0 }],
                  maxPositions: 2,
                  positionRatio: 0.4,
                },
              ] as never,
            }),
          ),
        ),
      ).rejects.toBeInstanceOf(BadRequestException);
    });
  });
});
