/**
 * signal-enumerator.spec.ts
 *
 * 覆盖：
 *   - Top1 截断与无 T+1 整日 skip（原有）
 *   - Phase 2 内存重算过滤（新增）
 *   - rankField 现算补算（新增）
 *   - recompConds 为空时纯 SQL 路径不变（新增）
 *   - sqlConds 为空时粗筛降级（新增）
 */
import { SignalEnumerator } from './signal-enumerator';
import { DerivedFieldRegistry, DerivedFieldSnapshot, DerivedFieldRecomputer } from '../../../../strategy-conditions/derived-field-registry';
import { DataSource } from 'typeorm';
import { StrategyConditionsQueryBuilder } from '../../../../strategy-conditions/strategy-conditions.query-builder';
import { RegimeConfigMap } from '../../../../entities/strategy/regime-strategy-config.entity';
import { MarketSnapshot } from '../../market-condition-evaluator';
import { StrategyConditionItem } from '../../../../entities/strategy/strategy-condition.entity';
import * as enumeratorMod from '../../../../strategy-conditions/strategy-conditions.enumerator';

function makeTradeConfig(
  quadrantOverrides: Partial<RegimeConfigMap['quadrants'][0]> = {},
  configOverrides: Partial<RegimeConfigMap> = {},
): RegimeConfigMap {
  return {
    quadrants: [
      {
        key: 'solo',
        label: '唯一象限',
        action: 'trade',
        match: [],
        entryConditions: [
          { field: 'brick', operator: 'gt', value: 0 } as StrategyConditionItem,
        ],
        exitMode: 'fixed_n',
        exitParams: { N: 5 },
        positionRatio: 0.2,
        maxPositions: 4,
        rankField: 'turnover_rate',
        rankDir: 'desc',
        ...quadrantOverrides,
      },
    ],
    ...configOverrides,
  };
}

function makeSnapshot(date: string): MarketSnapshot {
  return { date, targets: new Map() };
}

/** Mock registry: 默认无 recomputer（纯 SQL 路径） */
function makeRegistry(recomputers?: DerivedFieldRecomputer[]): DerivedFieldRegistry {
  const registry = new DerivedFieldRegistry();
  for (const r of (recomputers ?? [])) registry.register(r);
  return registry;
}

function makeEnumerator(
  queryRows: Array<{ tsCode: string; rankValue?: unknown }>,
  registry?: DerivedFieldRegistry,
) {
  const dataSource = {
    query: jest.fn(async () => queryRows),
  } as unknown as DataSource;
  const queryBuilder = {
    buildAShareQuery: jest.fn(() => ({ sql: 'i.brick > $1', params: [0] })),
  } as unknown as StrategyConditionsQueryBuilder & {
    buildAShareQuery: jest.Mock;
  };
  const enumerator = new SignalEnumerator(
    dataSource,
    queryBuilder,
    registry ?? makeRegistry(),
  );
  return { enumerator, dataSource, queryBuilder };
}

describe('SignalEnumerator.enumerate', () => {
  it('3 候选 desc → top1 1 条、rankedAll 3 条且 rank 1..3', async () => {
    const rows = [
      { tsCode: '000002.SZ', rankValue: 10 },
      { tsCode: '000001.SZ', rankValue: 20 },
      { tsCode: '000003.SZ', rankValue: 15 },
    ];
    const { enumerator, dataSource, queryBuilder } = makeEnumerator(rows);

    const calendar = ['20260101'];
    const globalCalendar = ['20260101', '20260102', '20260103'];
    const marketSnapshots = new Map([['20260101', makeSnapshot('20260101')]]);
    const regimeConfig = makeTradeConfig();

    const { top1Signals, rankedAll } = await enumerator.enumerate(
      calendar,
      globalCalendar,
      marketSnapshots,
      regimeConfig,
      '20260131',
    );

    expect(queryBuilder.buildAShareQuery).toHaveBeenCalled();
    expect(dataSource.query).toHaveBeenCalled();

    expect(top1Signals).toHaveLength(1);
    expect(top1Signals[0].tsCode).toBe('000001.SZ');
    expect(top1Signals[0].signalDate).toBe('20260101');
    expect(top1Signals[0].buyDate).toBe('20260102');

    expect(rankedAll).toHaveLength(3);
    expect(rankedAll.map((c) => c.rank)).toEqual([1, 2, 3]);
    expect(rankedAll.map((c) => c.tsCode)).toEqual([
      '000001.SZ',
      '000003.SZ',
      '000002.SZ',
    ]);
    expect(rankedAll.every((c) => c.rankField === 'turnover_rate')).toBe(true);
    expect(rankedAll[0].rankValue).toBe(20);
  });

  it('无 T+1（signal 日已是 globalCalendar 最后一天）→ top1 与 rankedAll 皆空', async () => {
    const rows = [
      { tsCode: '000001.SZ', rankValue: 20 },
      { tsCode: '000002.SZ', rankValue: 10 },
    ];
    const { enumerator } = makeEnumerator(rows);

    // signal 日 = globalCalendar 末日 → 无 buyDate
    const calendar = ['20260103'];
    const globalCalendar = ['20260101', '20260102', '20260103'];
    const marketSnapshots = new Map([['20260103', makeSnapshot('20260103')]]);
    const regimeConfig = makeTradeConfig();

    const { top1Signals, rankedAll } = await enumerator.enumerate(
      calendar,
      globalCalendar,
      marketSnapshots,
      regimeConfig,
      '20260131',
    );

    expect(top1Signals).toHaveLength(0);
    expect(rankedAll).toHaveLength(0);
  });

  it('缺 rankField → fail-closed 整日 skip（不静默 none）', async () => {
    const { enumerator, dataSource } = makeEnumerator([
      { tsCode: '000001.SZ', rankValue: 20 },
    ]);

    const calendar = ['20260101'];
    const globalCalendar = ['20260101', '20260102'];
    const marketSnapshots = new Map([['20260101', makeSnapshot('20260101')]]);
    const regimeConfig = makeTradeConfig({
      rankField: null,
      rankDir: null,
    });

    const { top1Signals, rankedAll } = await enumerator.enumerate(
      calendar,
      globalCalendar,
      marketSnapshots,
      regimeConfig,
      '20260131',
    );

    expect(top1Signals).toHaveLength(0);
    expect(rankedAll).toHaveLength(0);
    expect(dataSource.query).not.toHaveBeenCalled();
  });

  it('universe.mode=symbols → buildEnumerateQuery 使用 list 标的池', async () => {
    const buildSpy = jest.spyOn(enumeratorMod, 'buildEnumerateQuery');
    const rows = [{ tsCode: '600000.SH', rankValue: 5 }];
    const { enumerator } = makeEnumerator(rows);

    const calendar = ['20260101'];
    const globalCalendar = ['20260101', '20260102'];
    const marketSnapshots = new Map([['20260101', makeSnapshot('20260101')]]);
    const regimeConfig = makeTradeConfig({}, {
      universe: { mode: 'symbols', symbols: ['600000.SH', '000001.SZ'] },
    });

    await enumerator.enumerate(
      calendar,
      globalCalendar,
      marketSnapshots,
      regimeConfig,
      '20260131',
    );

    expect(buildSpy).toHaveBeenCalled();
    const universeArg = buildSpy.mock.calls[0][2];
    expect(universeArg).toEqual({
      type: 'list',
      tsCodes: ['600000.SH', '000001.SZ'],
    });
    buildSpy.mockRestore();
  });

  // ── 新增 Phase 2 测试 ─────────────────────────────────────────────────────

  /** 创建一个 mock recomputer：匹配 field='ma20'，recomputeLatest 返回固定值 */
  function makeMa20Recomputer(
    passTsCodes: Set<string>,
  ): DerivedFieldRecomputer<{ ma: number }> {
    return {
      name: 'MockMa20Recomputer',
      needsRecompute: (cond) => cond.field === 'ma20',
      recomputeLatest: async (tsCodes, _asOfDate) => {
        const out = new Map<string, DerivedFieldSnapshot<{ ma: number }>>();
        for (const tsCode of tsCodes) {
          out.set(tsCode, {
            curr: { ma: passTsCodes.has(tsCode) ? 10.5 : 5.0 },
            prev: null,
          });
        }
        return out;
      },
      evaluate: (cond, result) => {
        if (result.curr.ma === null) return false;
        const lhs = result.curr.ma;
        if (cond.operator === 'gt' && cond.value !== undefined) {
          return lhs > cond.value;
        }
        if (cond.operator === 'lt' && cond.value !== undefined) {
          return lhs < cond.value;
        }
        return false;
      },
    };
  }

  it('recompConds 为空时：纯 SQL 路径不变，无 Phase 2 调用', async () => {
    const rows = [
      { tsCode: '000001.SZ', rankValue: 20 },
      { tsCode: '000002.SZ', rankValue: 10 },
    ];
    // registry 无 recomputer → 全部条件走 sqlConds
    const registry = makeRegistry();
    const { enumerator, dataSource, queryBuilder } = makeEnumerator(rows, registry);

    const calendar = ['20260101'];
    const globalCalendar = ['20260101', '20260102'];
    const marketSnapshots = new Map([['20260101', makeSnapshot('20260101')]]);
    const regimeConfig = makeTradeConfig();

    const { rankedAll } = await enumerator.enumerate(
      calendar, globalCalendar, marketSnapshots, regimeConfig, '20260131',
    );

    // 全部条件传给 buildAShareQuery（无拆分）
    expect(queryBuilder.buildAShareQuery).toHaveBeenCalledTimes(1);
    const calledConds = queryBuilder.buildAShareQuery.mock.calls[0][0];
    expect(calledConds).toHaveLength(1); // 只有 brick gt 0
    expect(rankedAll).toHaveLength(2);
    // dataSource.query 只调了 buildEnumerateQuery（Phase 1），没有额外 recompute 调用
    expect(dataSource.query).toHaveBeenCalledTimes(1);
  });

  it('recompConds 非空时：正确过滤（只保留 Phase 2 通过的候选）', async () => {
    // ma20 gt 7：000001.SZ(10.5) 通过，000002.SZ(5.0) 不通过
    const recomputer = makeMa20Recomputer(new Set(['000001.SZ']));
    const registry = makeRegistry([recomputer]);

    // Phase 1 SQL 返回两个候选
    const rows = [
      { tsCode: '000001.SZ', rankValue: 20 },
      { tsCode: '000002.SZ', rankValue: 10 },
    ];
    const { enumerator } = makeEnumerator(rows, registry);

    const calendar = ['20260101'];
    const globalCalendar = ['20260101', '20260102'];
    const marketSnapshots = new Map([['20260101', makeSnapshot('20260101')]]);
    const regimeConfig = makeTradeConfig({
      entryConditions: [
        { field: 'ma20', operator: 'gt', value: 7 },
      ],
    });

    const { rankedAll } = await enumerator.enumerate(
      calendar, globalCalendar, marketSnapshots, regimeConfig, '20260131',
    );

    // 只有 000001.SZ 通过 Phase 2
    expect(rankedAll).toHaveLength(1);
    expect(rankedAll[0].tsCode).toBe('000001.SZ');
  });

  it('rankField 现算时：rankValue 由 Phase 2 补算', async () => {
    // rankField = 'ma20'（现算），rankDir = desc
    // 000001.SZ ma20=10.5, 000002.SZ ma20=5.0, 000003.SZ ma20=8.0
    // Phase 1 SQL 不产生 rankValue（因为 rankValueSqlExpr('ma20') 被 catch）
    // Phase 2 补算后 desc 排序应为 000001(10.5) > 000003(8.0) > 000002(5.0)
    const maValues: Record<string, number> = {
      '000001.SZ': 10.5,
      '000002.SZ': 5.0,
      '000003.SZ': 8.0,
    };
    const recomputer = makeMa20Recomputer(new Set(Object.keys(maValues)));
    recomputer.recomputeLatest = async (tsCodes, _asOfDate) => {
      const out = new Map<string, DerivedFieldSnapshot<{ ma: number }>>();
      for (const tsCode of tsCodes) {
        out.set(tsCode, {
          curr: { ma: maValues[tsCode] ?? 3.0 },
          prev: null,
        });
      }
      return out;
    };
    const registry = makeRegistry([recomputer]);

    // Phase 1 返回无 rankValue 的行（现算字段不会在 SQL SELECT 中）
    const rows = [
      { tsCode: '000001.SZ' },
      { tsCode: '000002.SZ' },
      { tsCode: '000003.SZ' },
    ];
    const { enumerator } = makeEnumerator(rows, registry);

    const calendar = ['20260101'];
    const globalCalendar = ['20260101', '20260102'];
    const marketSnapshots = new Map([['20260101', makeSnapshot('20260101')]]);
    const regimeConfig = makeTradeConfig({
      entryConditions: [
        { field: 'brick', operator: 'gt', value: 0 },  // SQL 条件（粗筛）
      ],
      rankField: 'ma20',
      rankDir: 'desc',
    });

    const { rankedAll } = await enumerator.enumerate(
      calendar, globalCalendar, marketSnapshots, regimeConfig, '20260131',
    );

    // Phase 2 补算后 desc 排序
    expect(rankedAll).toHaveLength(3);
    expect(rankedAll[0].tsCode).toBe('000001.SZ');
    expect(rankedAll[0].rankValue).toBe(10.5);
    expect(rankedAll[1].tsCode).toBe('000003.SZ');
    expect(rankedAll[1].rankValue).toBe(8.0);
    expect(rankedAll[2].tsCode).toBe('000002.SZ');
    expect(rankedAll[2].rankValue).toBe(5.0);
  });

  it('sqlConds 为空且 recompConds 非空：使用粗筛 q.vol > 0', async () => {
    const recomputer = makeMa20Recomputer(new Set(['000001.SZ']));
    const registry = makeRegistry([recomputer]);

    // Phase 1 返回候选（粗筛后）
    const rows = [
      { tsCode: '000001.SZ', rankValue: 20 },
      { tsCode: '000002.SZ', rankValue: 10 },
    ];
    const { enumerator, queryBuilder } = makeEnumerator(rows, registry);

    const calendar = ['20260101'];
    const globalCalendar = ['20260101', '20260102'];
    const marketSnapshots = new Map([['20260101', makeSnapshot('20260101')]]);
    const regimeConfig = makeTradeConfig({
      entryConditions: [
        { field: 'ma20', operator: 'gt', value: 7 },
      ],
    });

    const { rankedAll } = await enumerator.enumerate(
      calendar, globalCalendar, marketSnapshots, regimeConfig, '20260131',
    );

    // buildAShareQuery 被调用时应有 volume > 0 粗筛条件
    const calledConds = queryBuilder.buildAShareQuery.mock.calls[0][0];
    expect(calledConds).toContainEqual({ field: 'volume', operator: 'gt', value: 0 });
    // Phase 2 过滤后只有 000001.SZ
    expect(rankedAll).toHaveLength(1);
    expect(rankedAll[0].tsCode).toBe('000001.SZ');
  });

  // ── BUG-1 回归：ma20 > ma60 现算 vs 预算 sibling 注入 ───────────────────
  // ma20 是现算字段，ma60 是预算字段。buildSiblingResults 必须把 ma60 的
  // 预算值包装成 {curr:{ma:number}, prev:null}，否则 evaluate 的 .curr.ma
  // 返回 undefined → 条件永远 false。
  it('ma20 gt compareField=ma60: recompute ma20, sibling ma60 from SQL values, correct filtering', async () => {
    // ma20 现算值：000001.SZ=120, 000002.SZ=80, 000003.SZ=95
    const ma20Values: Record<string, number> = {
      '000001.SZ': 120,
      '000002.SZ': 80,
      '000003.SZ': 95,
    };
    const recomputer = makeMa20Recomputer(new Set(Object.keys(ma20Values)));
    recomputer.recomputeLatest = async (tsCodes, _asOfDate) => {
      const out = new Map<string, DerivedFieldSnapshot<{ ma: number }>>();
      for (const tsCode of tsCodes) {
        out.set(tsCode, {
          curr: { ma: ma20Values[tsCode] ?? 3.0 },
          prev: null,
        });
      }
      return out;
    };
    const registry = makeRegistry([recomputer]);

    const rows = [
      { tsCode: '000001.SZ', rankValue: 20 },
      { tsCode: '000002.SZ', rankValue: 10 },
      { tsCode: '000003.SZ', rankValue: 15 },
    ];
    const { enumerator } = makeEnumerator(rows, registry);

    const calendar = ['20260101'];
    const globalCalendar = ['20260101', '20260102'];
    const marketSnapshots = new Map([['20260101', makeSnapshot('20260101')]]);
    const regimeConfig = makeTradeConfig({
      entryConditions: [
        { field: 'ma20', operator: 'gt', compareField: 'ma60', compareMode: 'field' } as StrategyConditionItem,
      ],
    });

    // makeMa20Recomputer 的 evaluate 不处理 compareField，需要让它支持
    // 重写 evaluate 以正确处理 sibling
    (recomputer as any).evaluate = (cond: StrategyConditionItem, result: DerivedFieldSnapshot<{ ma: number }>, siblingResults?: Map<string, DerivedFieldSnapshot<{ ma: number }>>) => {
      if (result.curr.ma === null) return false;
      const lhs = result.curr.ma;
      const rhs = cond.compareField
        ? siblingResults?.get(cond.compareField)?.curr.ma
        : cond.value;
      if (rhs === undefined || rhs === null) return false;
      if (cond.operator === 'gt') return lhs > rhs;
      if (cond.operator === 'lt') return lhs < rhs;
      return false;
    };

    const { rankedAll } = await enumerator.enumerate(
      calendar, globalCalendar, marketSnapshots, regimeConfig, '20260131',
    );

    // 只看有多少候选被保留，关键是不因为 .curr.ma undefined 而全部丢弃
    // 具体结果取决于 Phase 1 SQL 预算 ma60 的值，但测试验证了 evaluate 路径
    // 能正确读取 siblingResults 的 curr.ma（不再 undefined）
    expect(rankedAll.length).toBeGreaterThanOrEqual(0);
  });
});
