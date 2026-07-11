import { BadRequestException } from '@nestjs/common';
import { RegimeBacktestService } from './regime-backtest.service';
import { CreateRegimeBacktestDto } from './dto/create-regime-backtest.dto';
import { RegimeConfigMap } from '../../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionItem } from '../../../entities/strategy/strategy-condition.entity';

function validConfig(): RegimeConfigMap {
  return {
    quadrants: [
      {
        key: 'bull',
        label: '强多头',
        action: 'trade',
        match: [
          {
            type: 'index',
            target: '000001.SH',
            field: 'macd',
            operator: 'gt',
            value: 0,
          },
        ],
        entryConditions: [{ field: 'brick', operator: 'gt', value: 0 } as StrategyConditionItem],
        exitMode: 'fixed_n',
        exitParams: { N: 5 },
        positionRatio: 0.2,
        maxPositions: 4,
        rankField: 'turnover_rate',
        rankDir: 'desc',
      },
      {
        key: 'bear',
        label: '空头',
        action: 'flat',
        match: [
          {
            type: 'index',
            target: '000001.SH',
            field: 'dif',
            operator: 'lte',
            value: 0,
          },
        ],
      },
    ],
  };
}

function baseDto(overrides?: Partial<CreateRegimeBacktestDto>): CreateRegimeBacktestDto {
  return {
    name: 'inline-config-run',
    config: validConfig(),
    capital: {
      initialCapital: 1_000_000,
      cost: {
        commissionPerSide: 0.00025,
        transferPerSide: 0.00001,
        stampSellBefore20230828: 0.001,
        stampSellFrom20230828: 0.0005,
        slippagePerSide: 0.0005,
      },
    },
    dateStart: '20240101',
    dateEnd: '20240630',
    ...overrides,
  };
}

describe('RegimeBacktestService.create (inline config)', () => {
  let service: RegimeBacktestService;
  let runRepo: {
    create: jest.Mock;
    save: jest.Mock;
  };
  let configRepo: {
    findOne: jest.Mock;
  };
  let warnSpy: jest.SpyInstance;

  beforeEach(() => {
    runRepo = {
      create: jest.fn((x) => x),
      save: jest.fn(async (x) => ({ id: 'run-1', ...x })),
    };
    configRepo = {
      findOne: jest.fn(),
    };
    service = new RegimeBacktestService(
      runRepo as never,
      {} as never,
      {} as never,
      {} as never,
      configRepo as never,
      {} as never,
      {} as never,
    );
    warnSpy = jest.spyOn((service as unknown as { logger: { warn: (...a: unknown[]) => void } }).logger, 'warn').mockImplementation(() => undefined);
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  it('snapshots dto.config and allows omitting regimeConfigId', async () => {
    const dto = baseDto();
    const saved = await service.create(dto);

    expect(configRepo.findOne).not.toHaveBeenCalled();
    expect(runRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({
        regimeConfigId: null,
        regimeConfigVersion: null,
        name: 'inline-config-run',
        config: {
          config: dto.config,
          capital: expect.objectContaining({
            initialCapital: 1_000_000,
            cost: dto.capital.cost,
          }),
        },
      }),
    );
    expect(saved.id).toBe('run-1');
  });

  it('ignores deprecated capital.positionRatio/maxPositions with warn', async () => {
    await service.create(
      baseDto({
        capital: {
          initialCapital: 1_000_000,
          cost: {
            commissionPerSide: 0.00025,
            transferPerSide: 0.00001,
            stampSellBefore20230828: 0.001,
            stampSellFrom20230828: 0.0005,
            slippagePerSide: 0.0005,
          },
          positionRatio: 0.25,
          maxPositions: 4,
        },
      }),
    );

    expect(warnSpy).toHaveBeenCalled();
    const created = runRepo.create.mock.calls[0][0];
    expect(created.config.capital.positionRatio).toBeUndefined();
    expect(created.config.capital.maxPositions).toBeUndefined();
  });

  it('rejects missing config', async () => {
    await expect(
      service.create(baseDto({ config: undefined as unknown as RegimeConfigMap })),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('rejects when optional regimeConfigId not found', async () => {
    configRepo.findOne.mockResolvedValue(null);
    await expect(
      service.create(baseDto({ regimeConfigId: 'missing-id' })),
    ).rejects.toThrow(/regime config missing-id not found/);
  });

  it('rejects kelly without source_kelly sizing mode', async () => {
    await expect(
      service.create(
        baseDto({
          capital: {
            ...baseDto().capital,
            kelly: {
              enabled: true,
              simTrades: 10,
              windowTrades: 10,
              stepTrades: 1,
              kellyFraction: 0.5,
              kellyMaxMult: 1,
              enableProbe: true,
            },
          },
        }),
      ),
    ).rejects.toThrow(/requires sizing.mode = source_kelly/);
  });

  it('accepts kelly + circuitBreaker in capital snapshot', async () => {
    const dto = baseDto({
      capital: {
        ...baseDto().capital,
        sizing: { mode: 'source_kelly', floorMult: 0.5, capMult: 1.5, kellyFraction: 0.5, kellyMaxMult: 1 },
        kelly: {
          enabled: true,
          simTrades: 10,
          windowTrades: 10,
          stepTrades: 1,
          kellyFraction: 0.5,
          kellyMaxMult: 1,
          enableProbe: true,
        },
        circuitBreaker: {
          enableCooldown: true,
          consecutiveLossesThreshold: 2,
          baseCooldownDays: 2,
          maxCooldownDays: 10,
          extendOnLoss: 1,
          reduceOnProfit: 1,
          enableDrawdownHalt: false,
          drawdownHaltPct: 0.15,
          drawdownResumePct: 0.1,
        },
      },
    });
    await service.create(dto);
    const created = runRepo.create.mock.calls[0][0];
    expect(created.config.capital.kelly).toEqual(dto.capital.kelly);
    expect(created.config.capital.circuitBreaker).toEqual(dto.capital.circuitBreaker);
  });
});
