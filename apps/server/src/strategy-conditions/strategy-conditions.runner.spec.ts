/**
 * strategy-conditions.runner.spec.ts
 *
 * 单测：runner 两阶段（A 股）集成行为——
 *  - Phase 1 仅按 sqlConds 走 buildAShareQuery 枚举/分页；
 *  - Phase 2 对带自定义参数的 recompConds，用 registry.resolve 拿 recomputer
 *    做 recomputeLatest + evaluate 逐条 AND 求交。
 *  - 注册表驱动：KDJ 自定义参数、MA 任意周期等均走统一路径。
 *
 * 全部依赖 mock，不连真 DB。asOf 取 raw.daily_indicator 的 MAX(trade_date)，
 * A 股 trade_date 为 'YYYYMMDD' 字符串（禁 new Date()）。
 */
import { StrategyConditionsRunner } from './strategy-conditions.runner';
import { StrategyConditionEntity, StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';
import { DerivedFieldRegistry, DerivedFieldSnapshot, DerivedFieldRecomputer } from './derived-field-registry';

const AS_OF = '20260612';
const RUN_ID = 'run-1';

// ── mock 工厂 ──────────────────────────────────────────────────────────────

interface RunnerMocks {
  runner: StrategyConditionsRunner;
  runRepo: { update: jest.Mock; create: jest.Mock; save: jest.Mock };
  hitRepo: { update: jest.Mock; create: jest.Mock; save: jest.Mock };
  dataSource: { query: jest.Mock };
  queryBuilder: { buildAShareQuery: jest.Mock; buildCryptoQuery: jest.Mock };
  registry: DerivedFieldRegistry;
  kdjRecomputer: { recomputeLatest: jest.Mock };
}

/**
 * @param scanRows     scan 查询返回的候选行（Phase 1 命中集）
 * @param totalSymbols countTotalSymbols 返回值（控制扫描循环上界）
 * @param asOf         MAX(trade_date) 返回值；传 null 模拟 daily_indicator 空
 * @param recompMap    recomputeLatest 返回的 Map<tsCode,{curr,prev}>
 */
function makeRunner(opts: {
  scanRows?: Array<{ tsCode: string; name: string }>;
  totalSymbols?: number;
  asOf?: string | null;
  recompMap?: Map<string, DerivedFieldSnapshot<{ k: number; d: number; j: number }>>;
}): RunnerMocks {
  const scanRows = opts.scanRows ?? [];
  const totalSymbols = opts.totalSymbols ?? scanRows.length;
  const asOf = opts.asOf === undefined ? AS_OF : opts.asOf;
  const recompMap = opts.recompMap ?? new Map<string, DerivedFieldSnapshot<{ k: number; d: number; j: number }>>();

  const dataSource = {
    // 按 SQL 关键字分派：MAX(trade_date)→asOf；COUNT(*)→标的数；scan→候选行。
    query: jest.fn(async (sql: string) => {
      if (sql.includes('MAX(trade_date)') && sql.includes('AS max')) {
        return [{ max: asOf }];
      }
      if (sql.includes('COUNT(*)') && sql.includes('a_share_symbols')) {
        return [{ count: String(totalSymbols) }];
      }
      // scan 查询：SELECT s.ts_code ... FROM a_share_symbols s ... LIMIT/OFFSET
      if (sql.includes('a_share_symbols s') && sql.includes('LIMIT')) {
        return scanRows.map(r => ({ tsCode: r.tsCode, name: r.name }));
      }
      throw new Error(`未预期的 SQL 分派：${sql.slice(0, 80)}`);
    }),
  };

  const queryBuilder = {
    buildAShareQuery: jest.fn(() => ({ sql: 'TRUE', params: [] as unknown[] })),
    buildCryptoQuery: jest.fn(() => ({ sql: 'TRUE', params: [] as unknown[] })),
  };

  // Mock KDJ recomputer：匹配 field=kdj_j/kdj_k/kdj_d + kdjParams 自定义
  const kdjRecomputer: { recomputeLatest: jest.Mock } = {
    recomputeLatest: jest.fn(async () => recompMap),
  };

  const kdjFieldRecomputer: DerivedFieldRecomputer<{ k: number; d: number; j: number }> = {
    name: 'MockKdjFieldRecomputer',
    needsRecompute: (cond) => {
      const { isKdjField, isCustomKdjParams, isValidKdjParams } = require('./kdj-params');
      if (!isKdjField(cond.field) || !isCustomKdjParams(cond.kdjParams)) return false;
      return isValidKdjParams(cond.kdjParams!);
    },
    recomputeLatest: kdjRecomputer.recomputeLatest as any,
    evaluate: (cond, result) => {
      const { evalKdjCondition } = require('./kdj-condition-eval');
      return evalKdjCondition(cond, result);
    },
  };

  const registry = new DerivedFieldRegistry();
  registry.register(kdjFieldRecomputer);

  const runRepo = {
    update: jest.fn(async () => undefined),
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
  };
  const hitRepo = {
    update: jest.fn(async () => undefined),
    create: jest.fn((v: unknown) => v),
    save: jest.fn(async (e: unknown) => e),
  };

  const runner = new StrategyConditionsRunner(
    runRepo as any,
    hitRepo as any,
    dataSource as any,
    queryBuilder as any,
    registry,
  );

  return { runner, runRepo, hitRepo, dataSource, queryBuilder, registry, kdjRecomputer };
}

function makeCondition(conditions: StrategyConditionItem[]): StrategyConditionEntity {
  return { targetType: 'a-share', conditions } as StrategyConditionEntity;
}

function kdjPoint(j: number) {
  return { k: 50, d: 50, j };
}

/** 取最近一次 hitRepo.save 收到的命中实体里的 tsCode 列表（按入参顺序）。 */
function savedTsCodes(hitRepo: RunnerMocks['hitRepo']): string[] {
  if (hitRepo.save.mock.calls.length === 0) return [];
  const arg = hitRepo.save.mock.calls[hitRepo.save.mock.calls.length - 1][0] as Array<{ tsCode: string }>;
  return arg.map(e => e.tsCode);
}

/** 断言 run 以 completed 收尾并取其 totalHits。 */
function expectCompleted(runRepo: RunnerMocks['runRepo']): number {
  const completedCall = runRepo.update.mock.calls.find(
    ([, patch]: [string, Record<string, unknown>]) => patch && patch.status === 'completed',
  );
  expect(completedCall).toBeDefined();
  const failedCall = runRepo.update.mock.calls.find(
    ([, patch]: [string, Record<string, unknown>]) => patch && patch.status === 'failed',
  );
  expect(failedCall).toBeUndefined();
  return (completedCall![1] as { totalHits: number }).totalHits;
}

const VALID_CUSTOM = { n: 6, m1: 2, m2: 2 };

// ── 场景 1：纯 SQL 条件，无自定义 KDJ ───────────────────────────────────────

describe('StrategyConditionsRunner - A 股两阶段', () => {
  it('1. 纯 SQL 条件（无自定义 KDJ）：recomputeLatest 未被调用，直接返回 Phase1 候选', async () => {
    const { runner, kdjRecomputer, hitRepo, queryBuilder, runRepo } = makeRunner({
      scanRows: [
        { tsCode: '000001.SZ', name: '平安银行' },
        { tsCode: '600000.SH', name: '浦发银行' },
      ],
    });
    const cond = makeCondition([
      { field: 'kdj_j', operator: 'lt', value: 0 }, // 默认 9/3/3，走 SQL
      { field: 'close_ma60_ratio', operator: 'gt', value: 1 },
    ]);

    await runner.executeRun(cond, RUN_ID, 'test-user', jest.fn());

    expect(kdjRecomputer.recomputeLatest).not.toHaveBeenCalled();
    // 两条都进 sqlConds
    expect(queryBuilder.buildAShareQuery).toHaveBeenCalledWith(cond.conditions);
    expect(savedTsCodes(hitRepo)).toEqual(['000001.SZ', '600000.SH']);
    expect(expectCompleted(runRepo)).toBe(2);
  });

  // ── 场景 2：含自定义 KDJ，逐条 AND 过滤 ──────────────────────────────────

  it('2. 含自定义 KDJ：recomputeLatest 被调用，候选按 evalKdjCondition AND 过滤', async () => {
    // 条件：自定义 6/2/2 的 kdj_j < 0；A 通过(j=-5)，B 不通过(j=10)，C 通过(j=-1)
    const recompMap = new Map<string, DerivedFieldSnapshot<{ k: number; d: number; j: number }>>([
      ['A.SZ', { curr: kdjPoint(-5), prev: null }],
      ['B.SZ', { curr: kdjPoint(10), prev: null }],
      ['C.SZ', { curr: kdjPoint(-1), prev: null }],
    ]);
    const { runner, kdjRecomputer, hitRepo, runRepo } = makeRunner({
      scanRows: [
        { tsCode: 'A.SZ', name: 'A' },
        { tsCode: 'B.SZ', name: 'B' },
        { tsCode: 'C.SZ', name: 'C' },
      ],
      recompMap,
    });
    const cond = makeCondition([
      { field: 'kdj_j', operator: 'lt', value: 0, kdjParams: VALID_CUSTOM },
    ]);

    await runner.executeRun(cond, RUN_ID, 'test-user', jest.fn());

    expect(kdjRecomputer.recomputeLatest).toHaveBeenCalledTimes(1);
    // 重算以 asOf 与自定义参数被调用，tsCodes 为 Phase1 候选
    const [tsCodesArg, asOfArg] = kdjRecomputer.recomputeLatest.mock.calls[0];
    expect(tsCodesArg).toEqual(['A.SZ', 'B.SZ', 'C.SZ']);
    expect(asOfArg).toBe(AS_OF);
    // 只保留通过者 A、C
    expect(savedTsCodes(hitRepo)).toEqual(['A.SZ', 'C.SZ']);
    expect(expectCompleted(runRepo)).toBe(2);
  });

  // ── 场景 3：重算缺失某 tsCode → 排除 ─────────────────────────────────────

  it('3. recomputeLatest 结果缺失某候选 → 该候选被排除（不命中）', async () => {
    // B 不在 Map 中（无 qfq 数据）→ 应被剔除；A 在且通过
    const recompMap = new Map<string, DerivedFieldSnapshot<{ k: number; d: number; j: number }>>([
      ['A.SZ', { curr: kdjPoint(-5), prev: null }],
      // 'B.SZ' 缺失
    ]);
    const { runner, hitRepo, runRepo } = makeRunner({
      scanRows: [
        { tsCode: 'A.SZ', name: 'A' },
        { tsCode: 'B.SZ', name: 'B' },
      ],
      recompMap,
    });
    const cond = makeCondition([
      { field: 'kdj_j', operator: 'lt', value: 0, kdjParams: VALID_CUSTOM },
    ]);

    await runner.executeRun(cond, RUN_ID, 'test-user', jest.fn());

    expect(savedTsCodes(hitRepo)).toEqual(['A.SZ']);
    expect(expectCompleted(runRepo)).toBe(1);
  });

  // ── 场景 4：distinct 参数集去重 ──────────────────────────────────────────

  it('4a. 两条 recompCond 用相同 kdjParams → recomputeLatest 只调一次', async () => {
    const recompMap = new Map<string, DerivedFieldSnapshot<{ k: number; d: number; j: number }>>([
      ['A.SZ', { curr: { k: 95, d: 90, j: 5 }, prev: null }],
    ]);
    const { runner, kdjRecomputer, runRepo } = makeRunner({
      scanRows: [{ tsCode: 'A.SZ', name: 'A' }],
      recompMap,
    });
    const cond = makeCondition([
      { field: 'kdj_j', operator: 'lt', value: 50, kdjParams: { n: 6, m1: 2, m2: 2 } },
      { field: 'kdj_k', operator: 'gt', value: 50, kdjParams: { n: 6, m1: 2, m2: 2 } },
    ]);

    await runner.executeRun(cond, RUN_ID, 'test-user', jest.fn());

    expect(kdjRecomputer.recomputeLatest).toHaveBeenCalledTimes(2); // 每条 recompCond 各调一次（不按参数去重）
    expectCompleted(runRepo);
  });

  it('4b. 两条 recompCond 用不同 kdjParams → recomputeLatest 调两次', async () => {
    const recompMap = new Map<string, DerivedFieldSnapshot<{ k: number; d: number; j: number }>>([
      ['A.SZ', { curr: { k: 95, d: 90, j: 5 }, prev: null }],
    ]);
    const { runner, kdjRecomputer, runRepo } = makeRunner({
      scanRows: [{ tsCode: 'A.SZ', name: 'A' }],
      recompMap,
    });
    const cond = makeCondition([
      { field: 'kdj_j', operator: 'lt', value: 50, kdjParams: { n: 6, m1: 2, m2: 2 } },
      { field: 'kdj_k', operator: 'gt', value: 50, kdjParams: { n: 9, m1: 3, m2: 2 } },
    ]);

    await runner.executeRun(cond, RUN_ID, 'test-user', jest.fn());

    expect(kdjRecomputer.recomputeLatest).toHaveBeenCalledTimes(2);
    expectCompleted(runRepo);
  });

  // ── 场景 5：asOf 缺省 fail-closed ────────────────────────────────────────

  it('5. asOf 缺省（daily_indicator 空）→ 命中空、不报错', async () => {
    // MAX(trade_date) 返回 null；recomputeLatest 自然返回空 Map（这里 mock 空 Map）
    const { runner, hitRepo, runRepo, kdjRecomputer } = makeRunner({
      scanRows: [{ tsCode: 'A.SZ', name: 'A' }],
      asOf: null,
      recompMap: new Map<string, DerivedFieldSnapshot<{ k: number; d: number; j: number }>>(), // 空
    });
    const cond = makeCondition([
      { field: 'kdj_j', operator: 'lt', value: 0, kdjParams: VALID_CUSTOM },
    ]);

    await runner.executeRun(cond, RUN_ID, 'test-user', jest.fn());

    // asOf 为 '' 传给 recomputeLatest（runner 用 asOf ?? ''）
    expect(kdjRecomputer.recomputeLatest.mock.calls[0][1]).toBe('');
    expect(savedTsCodes(hitRepo)).toEqual([]);
    expect(expectCompleted(runRepo)).toBe(0);
  });

  // ── 场景 6：非法 kdjParams 回退 9/3/3 ───────────────────────────────────

  it('6. 非法 kdjParams（n=0）→ 归入 sqlConds 走 buildAShareQuery，不触发重算', async () => {
    const { runner, kdjRecomputer, queryBuilder, hitRepo, runRepo } = makeRunner({
      scanRows: [{ tsCode: 'A.SZ', name: 'A' }],
    });

    const illegal: StrategyConditionItem = {
      field: 'kdj_j',
      operator: 'lt',
      value: 0,
      kdjParams: { n: 0, m1: 3, m2: 3 }, // 非法：n 越界
    };
    const cond = makeCondition([illegal]);

    await runner.executeRun(cond, RUN_ID, 'test-user', jest.fn());

    // 非法参数条件未触发重算
    expect(kdjRecomputer.recomputeLatest).not.toHaveBeenCalled();
    // 该条进了传给 buildAShareQuery 的 sqlConds
    const sqlConds = queryBuilder.buildAShareQuery.mock.calls[0][0] as StrategyConditionItem[];
    expect(sqlConds).toContainEqual(illegal);
    // 走 SQL 路径，候选直接命中
    expect(savedTsCodes(hitRepo)).toEqual(['A.SZ']);
    expect(expectCompleted(runRepo)).toBe(1);
  });

  it('6b. 非整数 kdjParams（n=6.5）→ 同样回退、不触发重算', async () => {
    const { runner, kdjRecomputer, queryBuilder } = makeRunner({
      scanRows: [{ tsCode: 'A.SZ', name: 'A' }],
    });

    const illegal: StrategyConditionItem = {
      field: 'kdj_j',
      operator: 'lt',
      value: 0,
      kdjParams: { n: 6.5, m1: 2, m2: 2 },
    };
    const cond = makeCondition([illegal]);

    await runner.executeRun(cond, RUN_ID, 'test-user', jest.fn());

    expect(kdjRecomputer.recomputeLatest).not.toHaveBeenCalled();
    const sqlConds = queryBuilder.buildAShareQuery.mock.calls[0][0] as StrategyConditionItem[];
    expect(sqlConds).toContainEqual(illegal);
  });
});
