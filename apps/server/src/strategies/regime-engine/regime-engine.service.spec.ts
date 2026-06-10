/**
 * regime-engine.service.spec.ts
 *
 * 单测：RegimeEngineService 编排逻辑（mock repo/dataSource/queryBuilder）。
 * 验证：
 *   - 幂等：先删后插在同一事务 manager 上按序发生。
 *   - 缺 oamv 行 / 指标列 null → fail-closed 落 unknown 记录，不扫描。
 *   - flat 象限 → 不扫描，落一条 flat 记录（ts_code null）。
 *   - 无 active 配置（regime 已知）→ 409 Conflict。
 *   - trade 象限 → 扫描 + 名称注入 + snapshot.close 落库。
 *   - createConfig / activateConfig 的校验与事务行为。
 */
import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { RegimeEngineService } from './regime-engine.service';
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

function makeMockDataSource(manager: ReturnType<typeof makeMockManager>) {
  return {
    transaction: jest.fn(async (cb: (m: unknown) => Promise<unknown>) => cb(manager)),
    // 显式声明形参，让 mock.calls 推断出 [sql, params] 元组便于断言
    query: jest.fn(async (_sql: string, _params?: unknown[]) => [] as unknown[]),
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
    oamvRepo: {
      findOne: jest.fn(async () => null),
      find: jest.fn(async () => []),
    },
    symbolRepo: {
      find: jest.fn(async () => []),
    },
  };
}

function makeMockQueryBuilder() {
  return {
    buildAShareQuery: jest.fn(() => ({ sql: 'i.macd > $1', params: [0] })),
  };
}

function makeOamvRow(overrides: Record<string, unknown> = {}) {
  return {
    tradeDate: '20260610',
    close: '1234.56',
    amvDif: 1.2,
    amvDea: 0.9,
    amvMacd: 0.6, // 默认 Q1
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
      Q1: {
        action: 'trade',
        label: '多头加速',
        entryConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
        exitMode: 'trailing_lock',
        exitParams: { maxHold: null },
      },
      Q2: { action: 'flat', label: '多头衰减', entryConditions: null, exitMode: null, exitParams: null },
      Q3: {
        action: 'trade',
        label: '反弹筑底',
        entryConditions: [{ field: 'kdj_j', operator: 'lt', value: 0 }],
        exitMode: 'fixed_n',
        exitParams: { N: 5 },
      },
      Q4: { action: 'flat', label: '空头', entryConditions: null, exitMode: null, exitParams: null },
    },
    ...overrides,
  };
}

interface Harness {
  service: RegimeEngineService;
  repos: ReturnType<typeof makeMockRepos>;
  manager: ReturnType<typeof makeMockManager>;
  dataSource: ReturnType<typeof makeMockDataSource>;
  queryBuilder: ReturnType<typeof makeMockQueryBuilder>;
  warnSpy: jest.SpyInstance;
}

function makeHarness(): Harness {
  const repos = makeMockRepos();
  const manager = makeMockManager();
  const dataSource = makeMockDataSource(manager);
  const queryBuilder = makeMockQueryBuilder();
  const service = new RegimeEngineService(
    repos.configRepo as any,
    repos.pickRepo as any,
    repos.oamvRepo as any,
    repos.symbolRepo as any,
    dataSource as any,
    queryBuilder as any,
  );
  const warnSpy = jest
    .spyOn((service as any).logger, 'warn')
    .mockImplementation(() => undefined);
  return { service, repos, manager, dataSource, queryBuilder, warnSpy };
}

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe('RegimeEngineService.runDaily', () => {
  it('缺 oamv 行 → fail-closed：warn + 不扫描 + 落 unknown 记录（带当前 active 版本）', async () => {
    const h = makeHarness();
    h.repos.oamvRepo.findOne.mockResolvedValue(null);
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());

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

  it('指标列 null（行存在）且无 active 配置 → unknown 记录 configVersion=null，不抛 409', async () => {
    const h = makeHarness();
    h.repos.oamvRepo.findOne.mockResolvedValue(makeOamvRow({ amvDif: null }));
    h.repos.configRepo.findOne.mockResolvedValue(null);

    const result = await h.service.runDaily('20260610');

    expect(result.regime).toBe('unknown');
    expect(result.configVersion).toBeNull();
    expect(h.manager.insert).toHaveBeenCalledWith(RegimeDailyPickEntity, [
      expect.objectContaining({ regime: 'unknown', action: 'unknown', configVersion: null }),
    ]);
    expect(h.queryBuilder.buildAShareQuery).not.toHaveBeenCalled();
  });

  it('regime 已知但无 active 配置 → 409，且不落任何记录', async () => {
    const h = makeHarness();
    h.repos.oamvRepo.findOne.mockResolvedValue(makeOamvRow()); // Q1
    h.repos.configRepo.findOne.mockResolvedValue(null);

    await expect(h.service.runDaily('20260610')).rejects.toThrow(ConflictException);
    await expect(h.service.runDaily('20260610')).rejects.toThrow('无生效配置，请先激活');
    expect(h.dataSource.transaction).not.toHaveBeenCalled();
  });

  it('flat 象限 → 不扫描，落一条 flat 记录（ts_code null，snapshot 带空仓理由）', async () => {
    const h = makeHarness();
    // dif>0 且 macd<=0 → Q2（配置中 flat）
    h.repos.oamvRepo.findOne.mockResolvedValue(makeOamvRow({ amvMacd: -0.5 }));
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());

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
    h.repos.oamvRepo.findOne.mockResolvedValue(makeOamvRow({ amvMacd: -0.5 })); // Q2 flat
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());

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
    h.repos.oamvRepo.findOne.mockResolvedValue(makeOamvRow()); // Q1 trade
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    h.dataSource.query
      // 第一查：单日枚举命中
      .mockResolvedValueOnce([{ tsCode: '000001.SZ' }, { tsCode: '600000.SH' }])
      // 第二查：当日收盘价（600000.SH 无行 → snapshot.close null）
      .mockResolvedValueOnce([{ tsCode: '000001.SZ', close: '10.50' }]);
    h.repos.symbolRepo.find.mockResolvedValue([
      { tsCode: '000001.SZ', name: '平安银行' },
    ]);

    const result = await h.service.runDaily('20260610');

    expect(h.queryBuilder.buildAShareQuery).toHaveBeenCalledWith(
      makeActiveConfig().config.Q1.entryConditions,
    );
    // 枚举 SQL 锚定当日：params 末位为 tradeDate
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
    h.repos.oamvRepo.findOne.mockResolvedValue(makeOamvRow());
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());
    h.dataSource.query.mockResolvedValueOnce([]); // 枚举 0 命中

    const result = await h.service.runDaily('20260610');

    expect(h.manager.delete).toHaveBeenCalledTimes(1);
    expect(h.manager.insert).not.toHaveBeenCalled();
    expect(result.pickCount).toBe(0);
  });

  it('脏配置：trade 象限 entryConditions 为空 → 409 拒绝全市场扫描', async () => {
    const h = makeHarness();
    h.repos.oamvRepo.findOne.mockResolvedValue(makeOamvRow());
    const cfg = makeActiveConfig();
    (cfg.config as any).Q1.entryConditions = [];
    h.repos.configRepo.findOne.mockResolvedValue(cfg);

    await expect(h.service.runDaily('20260610')).rejects.toThrow(ConflictException);
    expect(h.dataSource.query).not.toHaveBeenCalled();
  });

  it('缺省 tradeDate → 取最新 oamv 日', async () => {
    const h = makeHarness();
    h.repos.oamvRepo.find.mockResolvedValue([makeOamvRow({ tradeDate: '20260609' })]);
    h.repos.oamvRepo.findOne.mockResolvedValue(
      makeOamvRow({ tradeDate: '20260609', amvMacd: -0.5 }), // Q2 flat
    );
    h.repos.configRepo.findOne.mockResolvedValue(makeActiveConfig());

    const result = await h.service.runDaily();

    expect(result.tradeDate).toBe('20260609');
    expect(h.repos.oamvRepo.findOne).toHaveBeenCalledWith({
      where: { tradeDate: '20260609' },
    });
  });

  it('缺省 tradeDate 且 oamv_daily 表空 → 409', async () => {
    const h = makeHarness();
    h.repos.oamvRepo.find.mockResolvedValue([]);

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

  it('config 校验失败 → 400（缺象限）', async () => {
    const h = makeHarness();
    const cfg = validConfigJson() as Record<string, unknown>;
    delete cfg.Q3;

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
