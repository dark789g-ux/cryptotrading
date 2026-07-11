/**
 * signal-enumerator.spec.ts
 *
 * 覆盖 Top1 截断与无 T+1 整日 skip。
 * 用单象限空 match 通配，避免构造复杂 market snapshot。
 */
import { SignalEnumerator } from './signal-enumerator';
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

function makeEnumerator(queryRows: Array<{ tsCode: string; rankValue?: unknown }>) {
  const dataSource = {
    query: jest.fn(async () => queryRows),
  } as unknown as DataSource;
  const queryBuilder = {
    buildAShareQuery: jest.fn(() => ({ sql: 'i.brick > $1', params: [0] })),
  } as unknown as StrategyConditionsQueryBuilder;
  const enumerator = new SignalEnumerator(dataSource, queryBuilder);
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
});
