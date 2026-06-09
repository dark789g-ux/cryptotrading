/**
 * signal-stats.list-trades-options.spec.ts
 *
 * 纯函数单测：buildTradeListOptions 与 rangeOp。
 * 不依赖 DB / mock repo，直接验证返回的 where/order 对象结构。
 */
import {
  Between,
  MoreThanOrEqual,
  LessThanOrEqual,
  ILike,
} from 'typeorm';
import {
  buildTradeListOptions,
  rangeOp,
  SORT_COLUMN_MAP,
  VALID_EXIT_REASONS,
} from './signal-stats.list-trades-options';

const RUN_ID = 'run-uuid-1234';

// ── rangeOp ────────────────────────────────────────────────────────────────

describe('rangeOp', () => {
  it('两边均有 → Between(min, max)', () => {
    const op = rangeOp(0.01, 0.1);
    expect(op).toEqual(Between(0.01, 0.1));
  });

  it('仅 min → MoreThanOrEqual(min)', () => {
    const op = rangeOp(0.05, undefined);
    expect(op).toEqual(MoreThanOrEqual(0.05));
  });

  it('仅 max → LessThanOrEqual(max)', () => {
    const op = rangeOp(undefined, -0.02);
    expect(op).toEqual(LessThanOrEqual(-0.02));
  });

  it('均无 → undefined', () => {
    expect(rangeOp(undefined, undefined)).toBeUndefined();
  });

  it('min=NaN → 按无处理 → undefined（等效仅max不设）', () => {
    // NaN 由 parseNum 在 controller 层过滤为 undefined，此处验证 rangeOp 本身也容错
    expect(rangeOp(NaN, undefined)).toBeUndefined();
  });

  it('max=NaN → 按无处理 → undefined', () => {
    expect(rangeOp(undefined, NaN)).toBeUndefined();
  });

  it('min=NaN，max 有效 → 仅 LessThanOrEqual(max)', () => {
    const op = rangeOp(NaN, 0.2);
    expect(op).toEqual(LessThanOrEqual(0.2));
  });
});

// ── buildTradeListOptions — 默认行为 ──────────────────────────────────────

describe('buildTradeListOptions - 默认排序', () => {
  it('无 opts 时 order = { signalDate:ASC, tsCode:ASC, id:ASC }', () => {
    const { order } = buildTradeListOptions(RUN_ID);
    expect(order).toEqual({ signalDate: 'ASC', tsCode: 'ASC', id: 'ASC' });
  });

  it('非法 sortField 回落默认排序', () => {
    const { order } = buildTradeListOptions(RUN_ID, { sortField: 'INVALID_FIELD' });
    expect(order).toEqual({ signalDate: 'ASC', tsCode: 'ASC', id: 'ASC' });
  });

  it('空字符串 sortField 回落默认排序', () => {
    const { order } = buildTradeListOptions(RUN_ID, { sortField: '' });
    expect(order).toEqual({ signalDate: 'ASC', tsCode: 'ASC', id: 'ASC' });
  });

  it('where 始终含 runId', () => {
    const { where } = buildTradeListOptions(RUN_ID);
    expect((where as Record<string, unknown>).runId).toBe(RUN_ID);
  });
});

// ── buildTradeListOptions — 排序映射 ─────────────────────────────────────

describe('buildTradeListOptions - 排序映射', () => {
  const sortCases = Object.keys(SORT_COLUMN_MAP) as Array<keyof typeof SORT_COLUMN_MAP>;

  for (const key of sortCases) {
    it(`sortField=${key} asc → order[${SORT_COLUMN_MAP[key]}]='ASC', id='ASC'`, () => {
      const { order } = buildTradeListOptions(RUN_ID, { sortField: key, sortOrder: 'asc' });
      const o = order as Record<string, string>;
      expect(o[SORT_COLUMN_MAP[key]]).toBe('ASC');
      expect(o.id).toBe('ASC');
    });

    it(`sortField=${key} desc → order[${SORT_COLUMN_MAP[key]}]='DESC', id='ASC'`, () => {
      const { order } = buildTradeListOptions(RUN_ID, { sortField: key, sortOrder: 'desc' });
      const o = order as Record<string, string>;
      expect(o[SORT_COLUMN_MAP[key]]).toBe('DESC');
      expect(o.id).toBe('ASC');
    });
  }

  it('sortOrder 未指定时默认 ASC', () => {
    const { order } = buildTradeListOptions(RUN_ID, { sortField: 'ret' });
    const o = order as Record<string, string>;
    expect(o.ret).toBe('ASC');
  });
});

// ── buildTradeListOptions — tsCode 筛选 ──────────────────────────────────

describe('buildTradeListOptions - tsCode 筛选', () => {
  it('tsCode 有值 → ILike("%xx%")', () => {
    const { where } = buildTradeListOptions(RUN_ID, { tsCode: '600519' });
    expect((where as Record<string, unknown>).tsCode).toEqual(ILike('%600519%'));
  });

  it('tsCode 空字符串 → 不设该字段', () => {
    const { where } = buildTradeListOptions(RUN_ID, { tsCode: '' });
    expect((where as Record<string, unknown>).tsCode).toBeUndefined();
  });

  it('tsCode 纯空格 → 不设该字段', () => {
    const { where } = buildTradeListOptions(RUN_ID, { tsCode: '   ' });
    expect((where as Record<string, unknown>).tsCode).toBeUndefined();
  });

  it('tsCode 自动 trim 后拼入 ILike', () => {
    const { where } = buildTradeListOptions(RUN_ID, { tsCode: '  SH  ' });
    expect((where as Record<string, unknown>).tsCode).toEqual(ILike('%SH%'));
  });
});

// ── buildTradeListOptions — exitReason 白名单 ─────────────────────────────

describe('buildTradeListOptions - exitReason 白名单', () => {
  const validReasons = Array.from(VALID_EXIT_REASONS);

  for (const reason of validReasons) {
    it(`合法 exitReason=${reason} → where.exitReason='${reason}'`, () => {
      const { where } = buildTradeListOptions(RUN_ID, { exitReason: reason });
      expect((where as Record<string, unknown>).exitReason).toBe(reason);
    });
  }

  it('非白名单 exitReason → 不设 where.exitReason', () => {
    const { where } = buildTradeListOptions(RUN_ID, { exitReason: 'HACKED' });
    expect((where as Record<string, unknown>).exitReason).toBeUndefined();
  });

  it('空字符串 exitReason → 不设 where.exitReason', () => {
    const { where } = buildTradeListOptions(RUN_ID, { exitReason: '' });
    expect((where as Record<string, unknown>).exitReason).toBeUndefined();
  });

  it('exitReason=undefined → 不设 where.exitReason', () => {
    const { where } = buildTradeListOptions(RUN_ID, {});
    expect((where as Record<string, unknown>).exitReason).toBeUndefined();
  });
});

// ── buildTradeListOptions — ret 范围筛选 ─────────────────────────────────

describe('buildTradeListOptions - ret 范围三态', () => {
  it('retMin + retMax → Between', () => {
    const { where } = buildTradeListOptions(RUN_ID, { retMin: 0.01, retMax: 0.1 });
    expect((where as Record<string, unknown>).ret).toEqual(Between(0.01, 0.1));
  });

  it('仅 retMin → MoreThanOrEqual', () => {
    const { where } = buildTradeListOptions(RUN_ID, { retMin: 0.05 });
    expect((where as Record<string, unknown>).ret).toEqual(MoreThanOrEqual(0.05));
  });

  it('仅 retMax → LessThanOrEqual', () => {
    const { where } = buildTradeListOptions(RUN_ID, { retMax: -0.03 });
    expect((where as Record<string, unknown>).ret).toEqual(LessThanOrEqual(-0.03));
  });

  it('均无 → 不设 where.ret', () => {
    const { where } = buildTradeListOptions(RUN_ID, {});
    expect((where as Record<string, unknown>).ret).toBeUndefined();
  });
});

// ── buildTradeListOptions — holdDays 范围筛选 ─────────────────────────────

describe('buildTradeListOptions - holdDays 范围三态', () => {
  it('holdDaysMin + holdDaysMax → Between', () => {
    const { where } = buildTradeListOptions(RUN_ID, { holdDaysMin: 1, holdDaysMax: 10 });
    expect((where as Record<string, unknown>).holdDays).toEqual(Between(1, 10));
  });

  it('仅 holdDaysMin → MoreThanOrEqual', () => {
    const { where } = buildTradeListOptions(RUN_ID, { holdDaysMin: 5 });
    expect((where as Record<string, unknown>).holdDays).toEqual(MoreThanOrEqual(5));
  });

  it('仅 holdDaysMax → LessThanOrEqual', () => {
    const { where } = buildTradeListOptions(RUN_ID, { holdDaysMax: 3 });
    expect((where as Record<string, unknown>).holdDays).toEqual(LessThanOrEqual(3));
  });

  it('均无 → 不设 where.holdDays', () => {
    const { where } = buildTradeListOptions(RUN_ID, {});
    expect((where as Record<string, unknown>).holdDays).toBeUndefined();
  });
});

// ── buildTradeListOptions — 组合多个条件 ─────────────────────────────────

describe('buildTradeListOptions - 组合条件', () => {
  it('tsCode + retMin + sortField=ret desc 同时生效', () => {
    const { where, order } = buildTradeListOptions(RUN_ID, {
      tsCode: '600',
      retMin: 0.0,
      sortField: 'ret',
      sortOrder: 'desc',
    });
    expect((where as Record<string, unknown>).tsCode).toEqual(ILike('%600%'));
    expect((where as Record<string, unknown>).ret).toEqual(MoreThanOrEqual(0.0));
    expect((order as Record<string, string>).ret).toBe('DESC');
    expect((order as Record<string, string>).id).toBe('ASC');
  });

  it('纯函数无副作用：多次调用同参数结果一致', () => {
    const opts = { sortField: 'holdDays', sortOrder: 'asc' as const, holdDaysMin: 2 };
    const r1 = buildTradeListOptions(RUN_ID, opts);
    const r2 = buildTradeListOptions(RUN_ID, opts);
    // 深度对等（TypeORM FindOperator 有 _value 属性，toEqual 递归比较）
    expect(r1).toEqual(r2);
  });
});

// ── buildTradeListOptions — listTrades service 层集成（mock repo） ────────

describe('buildTradeListOptions - service 层 listTrades 行为', () => {
  /**
   * 验证 service.listTrades 把 opts 正确传递给 findAndCount，
   * 并对 symbolRepo.find 返回的名称正确注入 name 字段。
   * 使用 mock repo，不连 DB。
   */

  function makeRunRepo(run: unknown) {
    return { findOne: jest.fn(async () => run) };
  }

  function makeTradeRepo(items: unknown[], total: number) {
    return { findAndCount: jest.fn(async () => [items, total]) };
  }

  function makeSymbolRepo(rows: unknown[]) {
    return { find: jest.fn(async () => rows) };
  }

  function makeMinimalService(
    runRepo: ReturnType<typeof makeRunRepo>,
    tradeRepo: ReturnType<typeof makeTradeRepo>,
    symbolRepo: ReturnType<typeof makeSymbolRepo>,
  ) {
    // 动态 import 避免循环依赖；直接实例化即可（service 无私有化构造）
    const { SignalStatsService } = require('./signal-stats.service') as {
      SignalStatsService: new (...args: unknown[]) => { listTrades: (...args: unknown[]) => Promise<unknown> };
    };
    return new SignalStatsService(
      { create: jest.fn(), save: jest.fn(), findOne: jest.fn(), find: jest.fn() } as unknown,
      runRepo as unknown,
      tradeRepo as unknown,
      symbolRepo as unknown,
      { query: jest.fn(async () => [{ minDate: '20100101', maxDate: '20301231' }]) } as unknown,
      { executeRun: jest.fn() } as unknown,
    );
  }

  it('run 不存在时 listTrades 抛 NotFoundException', async () => {
    const { NotFoundException } = require('@nestjs/common') as typeof import('@nestjs/common');
    const svc = makeMinimalService(
      makeRunRepo(null),
      makeTradeRepo([], 0),
      makeSymbolRepo([]),
    );
    await expect(svc.listTrades('no-run', 1, 50)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('items 为空时 symbolRepo.find 不调用（codes 为空）', async () => {
    const run = { id: 'run-1' };
    const symRepo = makeSymbolRepo([]);
    const svc = makeMinimalService(
      makeRunRepo(run),
      makeTradeRepo([], 0),
      symRepo,
    );
    const result = await svc.listTrades('run-1', 1, 50) as { total: number; items: unknown[] };
    expect(result.total).toBe(0);
    expect(result.items).toHaveLength(0);
    expect(symRepo.find).not.toHaveBeenCalled();
  });

  it('name 注入：命中 → 正确名称，未命中 → null', async () => {
    const run = { id: 'run-2' };
    const trades = [
      { id: 't1', tsCode: '600519.SH', ret: '0.05', holdDays: 3, signalDate: '20240101', buyDate: '20240102', exitDate: '20240105', buyPrice: '100', exitPrice: '105', exitReason: 'max_hold', runId: 'run-2' },
      { id: 't2', tsCode: '000001.SZ', ret: '-0.02', holdDays: 1, signalDate: '20240101', buyDate: '20240102', exitDate: '20240103', buyPrice: '10', exitPrice: '9.8', exitReason: 'signal', runId: 'run-2' },
    ];
    const symRepo = makeSymbolRepo([
      { tsCode: '600519.SH', name: '贵州茅台' },
      // 000001.SZ 故意不返回，期望 name=null
    ]);
    const svc = makeMinimalService(
      makeRunRepo(run),
      makeTradeRepo(trades, 2),
      symRepo,
    );
    const result = await svc.listTrades('run-2', 1, 50) as { total: number; items: Array<{ tsCode: string; name: string | null }> };
    expect(result.total).toBe(2);

    const mao = result.items.find((i) => i.tsCode === '600519.SH');
    expect(mao?.name).toBe('贵州茅台');

    const unknown = result.items.find((i) => i.tsCode === '000001.SZ');
    expect(unknown?.name).toBeNull();
  });

  it('findAndCount 以 buildTradeListOptions 结果的 where/order 调用', async () => {
    const run = { id: 'run-3' };
    const tradeRepo = makeTradeRepo([], 0);
    const svc = makeMinimalService(
      makeRunRepo(run),
      tradeRepo,
      makeSymbolRepo([]),
    );
    await svc.listTrades('run-3', 1, 50, { sortField: 'ret', sortOrder: 'desc', retMin: 0.0 });
    const callArgs = (tradeRepo.findAndCount as jest.Mock).mock.calls[0][0] as {
      where: Record<string, unknown>;
      order: Record<string, string>;
      skip: number;
      take: number;
    };
    // order.ret 应为 DESC
    expect(callArgs.order.ret).toBe('DESC');
    // where.ret 应为 MoreThanOrEqual(0.0)
    expect(callArgs.where.ret).toEqual(MoreThanOrEqual(0.0));
    // skip/take 正确
    expect(callArgs.skip).toBe(0);
    expect(callArgs.take).toBe(50);
  });
});
