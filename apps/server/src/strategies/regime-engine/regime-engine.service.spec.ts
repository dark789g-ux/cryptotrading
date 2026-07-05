/**
 * regime-engine.service.spec.ts
 *
 * 单测：RegimeEngineService 编排逻辑（mock repo/dataSource/queryBuilder）。
 * 验证：
 *   - 幂等：先删后插在同一事务 manager 上按序发生。
 *   - index_daily 缺行 / 指标列 null → fail-closed 落 unknown 记录，不扫描。
 *   - 无 active 配置 → 409 Conflict。
 *   - flat 象限 → 不扫描，落一条 flat 记录（ts_code null）。
 *   - trade 象限 → 扫描 + 名称注入 + snapshot.close 落库。
 *   - createConfig / activateConfig 的校验与事务行为。
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RegimeEngineService } from './regime-engine.service';
import { IndexDailyQuoteEntity } from '../../entities/index-daily/index-daily-quote.entity';
import { IndexDailyIndicatorEntity } from '../../entities/index-daily/index-daily-indicator.entity';
import { RegimeDailyPickEntity } from '../../entities/strategy/regime-daily-pick.entity';
import { RegimeStrategyConfigEntity } from '../../entities/strategy/regime-strategy-config.entity';

// ── mock 工厂 ──────────────────────────────────────────────────────────────

function makeMockManager() {
  return {
    delete: jest.fn(async () => undefined),
    insert: jest.fn(async () => undefined),
    update: jest.fn(async () => undefined),
    findOne: jest.fn(async () => null),
  };
}

function makeMockQueryBuilder() {
  const chain = {
    select: jest.fn(function () { return chain; }),
    from: jest.fn(function () { return chain; }),
    where: jest.fn(function () { return chain; }),
    getMany: jest.fn(async () => []),
    getRawOne: jest.fn(async () => null),
  };
  return chain;
}

function makeMockIndexRepo() {
  const qb = makeMockQueryBuilder();
  return {
    createQueryBuilder: jest.fn(() => qb),
  };
}

function makeMockDataSource(
  manager: ReturnType<typeof makeMockManager>,
  indexQuoteRepo: ReturnType<typeof makeMockIndexRepo>,
  indexIndicatorRepo: ReturnType<typeof makeMockIndexRepo>,
) {
  return {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    query: jest.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]),
    getRepository: jest.fn((entity: unknown) => {
      if (entity === IndexDailyQuoteEntity) return indexQuoteRepo;
      if (entity === IndexDailyIndicatorEntity) return indexIndicatorRepo;
      return {};
    }),
    createQueryBuilder: jest.fn(() => makeMockQueryBuilder()),
  };
}

function makeMockRepos() {
  return {
    configRepo: {
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
      create: jest.fn((v: unknown) => v),
      save: jest.fn(async (e: unknown) => e),
    },
    pickRepo: {
      find: jest.fn(async () => []),
    },
    symbolRepo: {
      find: jest.fn(async () => []),
    },
    indexQuoteRepo: makeMockIndexRepo(),
    indexIndicatorRepo: makeMockIndexRepo(),
  };
}

function makeMockQueryBuilderHelper() {
  return {
    buildAShareQuery: jest.fn(() => ({ sql: 'i.macd > $1', params: [0] })),
  };
}

function makeIndexQuoteRow(overrides: Record<string, unknown> = {}) {
  return {
    tsCode: '000001.SH',
    tradeDate: '20260610',
    open: 3000,
    high: 3050,
    low: 2990,
    close: 3040,
    preClose: 3020,
    change: 20,
    pctChange: 0.66,
    volHand: 1_000_000,
    amount: 500_000,
    ...overrides,
  };
}

function makeIndexIndicatorRow(overrides: Record<string, unknown> = {}) {
  return {
    tsCode: '000001.SH',
    tradeDate: '20260610',
    ma5: 3020,
    ma30: 3000,
    ma60: 2980,
    ma120: 2950,
    ma240: 2900,
    dif: 10,
    dea: 5,
    macd: 10,
    kdjK: 55,
    kdjD: 45,
    kdjJ: 75,
    bbi: 3005,
    brick: 1,
    brickDelta: 0.5,
    brickXg: true,
    ...overrides,
  };
}

function makeActiveConfig(overrides: Record<string, unknown> = {}) {
  return {
    id: 'cfg-1',
    version: 3,
    status: 'active',
    note: null,
    config: {
      quadrants: [
        {
          key: 'Q1',
          label: '多头加速',
          action: 'trade',
          match: [
            { type: 'index', target: '000001.SH', field: 'dif', operator: 'gt', value: 0 },
            { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', value: 0 },
          ],
          entryConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
          exitMode: 'trailing_lock',
          exitParams: { maxHold: null },
        },
        {
          key: 'Q2',
          label: '多头衰减',
          action: 'flat',
          match: [
            { type: 'index', target: '000001.SH', field: 'dif', operator: 'gt', value: 0 },
            { type: 'index', target: '000001.SH', field: 'macd', operator: 'lte', value: 0 },
          ],
        },
        {
          key: 'Q3',
          label: '反弹筑底',
          action: 'trade',
          match: [
            { type: 'index', target: '000001.SH', field: 'dif', operator: 'lte', value: 0 },
            { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', value: 0 },
          ],
          entryConditions: [{ field: 'kdj_j', operator: 'lt', value: 0 }],
          exitMode: 'fixed_n',
          exitParams: { N: 5 },
        },
        {
          key: 'Q4',
          label: '空头',
          action: 'flat',
          match: [
            { type: 'index', target: '000001.SH', field: 'dif', operator: 'lte', value: 0 },
            { type: 'index', target: '000001.SH', field: 'macd', operator: 'lte', value: 0 },
          ],
        },
      ],
    },
    ...overrides,
  };
}

interface Harness {
  service: RegimeEngineService;
  repos: ReturnType<typeof makeMockRepos>;
  manager: ReturnType<typeof makeMockManager>;
  dataSource: ReturnType<typeof makeMockDataSource>;
  queryBuilder: ReturnType<typeof makeMockQueryBuilderHelper>;
  warnSpy: jest.SpyInstance;
}

function makeHarness(): Harness {
  const repos = makeMockRepos();
  const manager = makeMockManager();
  const dataSource = makeMockDataSource(manager, repos.indexQuoteRepo, repos.indexIndicatorRepo);
  const queryBuilder = makeMockQueryBuilderHelper();
  const service = new RegimeEngineService(
    repos.configRepo as any,
    repos.pickRepo as any,
    repos.symbolRepo as any,
    dataSource as any,
    queryBuilder as any,
  );
  const warnSpy = jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { service, repos, manager, dataSource, queryBuilder, warnSpy };
}

/** 构造 trade 日：index snapshot 命中 Q1 + 扫描枚举/收盘价查询 */
function mockTradeDaySnapshot(
  h: Harness,
  enumHits: unknown[] = [{ tsCode: '000001.SZ' }, { tsCode: '600000.SH' }],
  closeRows: unknown[] = [{ tsCode: '000001.SZ', close: '10.50' }],
) {
  h.repos.indexQuoteRepo.createQueryBuilder().getMany.mockResolvedValue([makeIndexQuoteRow()]);
  h.repos.indexIndicatorRepo.createQueryBuilder().getMany.mockResolvedValue([makeIndexIndicatorRow()]);
  h.dataSource.query
    .mockResolvedValueOnce(enumHits)
    .mockResolvedValueOnce(closeRows);
}

/** 构造 flat 日：index snapshot 命中 Q2（macd <= 0） */
function mockFlatDaySnapshot(h: Harness) {
  h.repos.indexQuoteRepo.createQueryBuilder().getMany.mockResolvedValue([makeIndexQuoteRow()]);
  h.repos.indexIndicatorRepo.createQueryBuilder().getMany.mockResolvedValue([
    makeIndexIndicatorRow({ macd: -0.5 }),
  ]);
}

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe('RegimeEngineService.runDaily', () => {
  it('index_daily 缺行 → fail-closed：warn + 不扫描 + 落 unknown 记录', async () => {
    const h = makeHarness();
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    // quote / indicator 均缺行 → snapshot 目标字段全 null → classifyRegime unknown
    h.repos.indexQuoteRepo.createQueryBuilder().getMany.mockResolvedValue([]);
    h.repos.indexIndicatorRepo.createQueryBuilder().getMany.mockResolvedValue([]);

    const result = await h.service.runDaily('20260610');

    expect(h.warnSpy).toHaveBeenCalledWith(expect.stringContaining('20260610'));
    expect(h.queryBuilder.buildAShareQuery).not.toHaveBeenCalled();
    expect(h.dataSource.query).not.toHaveBeenCalled();
    expect(h.manager.delete).toHaveBeenCalledWith(RegimeDailyPickEntity, {
      tradeDate: '20260610',
    });
    expect(h.manager.insert).toHaveBeenCalledWith(RegimeDailyPickEntity, [
      expect.objectContaining({
        tradeDate: '20260610',
        regime: 'unknown',
        action: 'unknown',
        configVersion: 3,
        tsCode: null,
      }),
    ]);
    expect(result).toEqual({
      tradeDate: '20260610',
      regime: 'unknown',
      action: 'unknown',
      configVersion: 3,
      pickCount: 0,
    });
  });

  it('match 用 index 字段但 index_daily 缺行 → unknown 记录，不扫描', async () => {
    const h = makeHarness();
    const cfg = makeActiveConfig();
    cfg.config.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'dif', operator: 'gt', value: 0 },
      { type: 'index', target: '000001.SH', field: 'close', operator: 'gt', value: 0 },
    ];
    h.repos.configRepo.findOne.mockResolvedValue(cfg);
    h.repos.indexQuoteRepo.createQueryBuilder().getMany.mockResolvedValue([]);
    h.repos.indexIndicatorRepo.createQueryBuilder().getMany.mockResolvedValue([]);

    const result = await h.service.runDaily('20260610');

    expect(result.regime).toBe('unknown');
    expect(result.configVersion).toBe(3);
    expect(h.queryBuilder.buildAShareQuery).not.toHaveBeenCalled();
  });

  it('无 active 配置 → 409，且不落任何记录', async () => {
    const h = makeHarness();
    h.repos.configRepo.findOne.mockResolvedValue(null);

    await expect(h.service.runDaily('20260610')).rejects.toThrow(ConflictException);
    await expect(h.service.runDaily('20260610')).rejects.toThrow('无生效配置，请先激活');
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('flat 象限 → 不扫描，落一条 flat 记录（ts_code null，snapshot 带空仓理由）', async () => {
    const h = makeHarness();
    // dif>0 且 macd<=0 → Q2（配置中 flat）
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    mockFlatDaySnapshot(h);

    const result = await h.service.runDaily('20260610');

    expect(h.queryBuilder.buildAShareQuery).not.toHaveBeenCalled();
    expect(h.dataSource.query).not.toHaveBeenCalled();
    expect(h.manager.insert).toHaveBeenCalledWith(RegimeDailyPickEntity, [
      expect.objectContaining({
        tradeDate: '20260610',
        regime: 'Q2',
        action: 'flat',
        configVersion: 3,
        tsCode: null,
        name: null,
        snapshot: { label: '多头衰减' },
      }),
    ]);
    expect(result).toEqual({
      tradeDate: '20260610',
      regime: 'Q2',
      action: 'flat',
      configVersion: 3,
      pickCount: 0,
    });
  });

  it('幂等：先删后插，同一事务 manager，删除在插入之前', async () => {
    const h = makeHarness();
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    mockFlatDaySnapshot(h);

    await h.service.runDaily('20260610');

    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(h.manager.delete).toHaveBeenCalledTimes(1);
    expect(h.manager.insert).toHaveBeenCalledTimes(1);
    const deleteOrder = h.manager.delete.mock.invocationCallOrder[0];
    const insertOrder = h.manager.insert.mock.invocationCallOrder[0];
    expect(deleteOrder).toBeLessThan(insertOrder);
  });

  it('trade 象限 → 当日扫描 + 名称注入 + snapshot.close 落库', async () => {
    const h = makeHarness();
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    mockTradeDaySnapshot(h);
    h.repos.symbolRepo.find.mockResolvedValue([
      { tsCode: '000001.SZ', name: '平安银行' },
    ]);

    const result = await h.service.runDaily('20260610');

    expect(h.queryBuilder.buildAShareQuery).toHaveBeenCalledWith(
      makeActiveConfig().config.quadrants[0].entryConditions,
    );
    // 枚举 SQL 锚定当日：params 末位为 tradeDate（第 1、2 次 query）
    const [enumSql, enumParams] = h.dataSource.query.mock.calls[0];
    expect(enumSql).toContain('raw.daily_indicator i');
    expect(enumParams).toEqual([0, '20260610']);

    expect(h.manager.insert).toHaveBeenCalledWith(RegimeDailyPickEntity, [
      expect.objectContaining({
        tsCode: '000001.SZ',
        name: '平安银行',
        regime: 'Q1',
        action: 'trade',
        configVersion: 3,
        snapshot: { close: 10.5 },
      }),
      expect.objectContaining({
        tsCode: '600000.SH',
        name: null,
        snapshot: { close: null },
      }),
    ]);
    expect(result.pickCount).toBe(2);
    expect(result.action).toBe('trade');
  });

  it('trade 象限命中 0 → 删旧后不插入，pickCount=0', async () => {
    const h = makeHarness();
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    h.repos.indexQuoteRepo.createQueryBuilder().getMany.mockResolvedValue([makeIndexQuoteRow()]);
    h.repos.indexIndicatorRepo.createQueryBuilder().getMany.mockResolvedValue([makeIndexIndicatorRow()]);
    h.dataSource.query.mockResolvedValueOnce([]); // 枚举 0 命中

    const result = await h.service.runDaily('20260610');

    expect(h.manager.delete).toHaveBeenCalledTimes(1);
    expect(h.manager.insert).not.toHaveBeenCalled();
    expect(result.pickCount).toBe(0);
  });

  it('脏配置：trade 象限 entryConditions 为空 → 409 拒绝全市场扫描', async () => {
    const h = makeHarness();
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    const cfg = makeActiveConfig();
    (cfg.config.quadrants[0] as any).entryConditions = [];
    h.repos.configRepo.findOne.mockResolvedValue(cfg);
    h.repos.indexQuoteRepo.createQueryBuilder().getMany.mockResolvedValue([makeIndexQuoteRow()]);
    h.repos.indexIndicatorRepo.createQueryBuilder().getMany.mockResolvedValue([makeIndexIndicatorRow()]);

    await expect(h.service.runDaily('20260610')).rejects.toThrow(ConflictException);
    expect(h.dataSource.query).not.toHaveBeenCalled(); // 仅 snapshot 查询，未进入扫描
  });

  it('缺省 tradeDate → 取最新 index_daily 交易日', async () => {
    const h = makeHarness();
    const latestQb = makeMockQueryBuilder();
    latestQb.getRawOne.mockResolvedValue({ latestDate: '20260609' });
    h.dataSource.createQueryBuilder.mockImplementation(() => latestQb);
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    h.repos.indexQuoteRepo.createQueryBuilder().getMany.mockResolvedValue([makeIndexQuoteRow({ tradeDate: '20260609' })]);
    h.repos.indexIndicatorRepo.createQueryBuilder().getMany.mockResolvedValue([
      makeIndexIndicatorRow({ tradeDate: '20260609', macd: -0.5 }),
    ]);

    const result = await h.service.runDaily();

    expect(result.tradeDate).toBe('20260609');
    expect(result.regime).toBe('Q2');
  });

  it('缺省 tradeDate 且 index_daily_quotes 表空 → 409', async () => {
    const h = makeHarness();
    const emptyQb = makeMockQueryBuilder();
    emptyQb.getRawOne.mockResolvedValue({ latestDate: null });
    h.dataSource.createQueryBuilder.mockImplementation(() => emptyQb);

    await expect(h.service.runDaily()).rejects.toThrow(ConflictException);
  });

  it('tradeDate 格式非法 → 400', async () => {
    const h = makeHarness();
    await expect(h.service.runDaily('2026-06-10')).rejects.toThrow(BadRequestException);
  });
});

describe('RegimeEngineService.createConfig', () => {
  function validConfigJson() {
    return makeActiveConfig().config;
  }

  it('合法配置缺省 version → 自动 max+1，落 draft', async () => {
    const h = makeHarness();
    h.repos.configRepo.find.mockResolvedValue([{ version: 3 }]);

    await h.service.createConfig({ config: validConfigJson(), note: '测试' });

    expect(h.repos.configRepo.create).toHaveBeenCalledWith(
      expect.objectContaining({ version: 4, status: 'draft', note: '测试' }),
    );
    expect(h.repos.configRepo.save).toHaveBeenCalled();
  });

  it('显式 version 已存在 → 409', async () => {
    const h = makeHarness();
    h.repos.configRepo.findOne.mockResolvedValue({ version: 3 });

    await expect(
      h.service.createConfig({ version: 3, config: validConfigJson() }),
    ).rejects.toThrow(ConflictException);
  });

  it('config 校验失败 → 400（quadrants 为空）', async () => {
    const h = makeHarness();
    const cfg = validConfigJson() as Record<string, unknown>;
    cfg.quadrants = [];

    await expect(h.service.createConfig({ config: cfg })).rejects.toThrow(
      BadRequestException,
    );
    expect(h.repos.configRepo.save).not.toHaveBeenCalled();
  });
});

describe('RegimeEngineService.activateConfig', () => {
  it('事务内：原 active 改 archived、目标改 active', async () => {
    const h = makeHarness();
    h.manager.findOne.mockResolvedValue({ id: 'cfg-2', version: 4, status: 'draft' });

    const result = await h.service.activateConfig('cfg-2');

    expect(h.dataSource.transaction).toHaveBeenCalledTimes(1);
    expect(h.manager.update).toHaveBeenNthCalledWith(
      1,
      RegimeStrategyConfigEntity,
      { status: 'active' },
      { status: 'archived' },
    );
    expect(h.manager.update).toHaveBeenNthCalledWith(
      2,
      RegimeStrategyConfigEntity,
      { id: 'cfg-2' },
      { status: 'active' },
    );
    expect(result.status).toBe('active');
  });

  it('目标不存在 → 404', async () => {
    const h = makeHarness();
    h.manager.findOne.mockResolvedValue(null);

    await expect(h.service.activateConfig('nope')).rejects.toThrow(NotFoundException);
    expect(h.manager.update).not.toHaveBeenCalled();
  });

  it('目标已是 active → 幂等，不再 update', async () => {
    const h = makeHarness();
    h.manager.findOne.mockResolvedValue({ id: 'cfg-1', version: 3, status: 'active' });

    const result = await h.service.activateConfig('cfg-1');

    expect(h.manager.update).not.toHaveBeenCalled();
    expect(result.status).toBe('active');
  });
});
