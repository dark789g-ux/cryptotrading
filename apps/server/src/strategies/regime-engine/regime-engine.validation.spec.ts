/**
 * regime-engine.validation.spec.ts
 *
 * regime 配置校验单测（v3 分桶条件）。
 */
import {
  validateRegimeConfig,
  checkQuadrantOverlapWarnings,
  isDerivedField,
} from './regime-engine.validation';
import {
  QuadrantEntry,
  RegimeBucketCondition,
  RegimeConfigMap,
  MatchGroup,
  MatchNode,
} from '../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';

function cond(field: string, operator: string, value?: number, compareField?: string): StrategyConditionItem {
  const c: StrategyConditionItem = { field, operator } as StrategyConditionItem;
  if (value !== undefined) c.value = value;
  if (compareField !== undefined) c.compareField = compareField;
  return c;
}

function matchCond(
  type: 'index' | 'stock',
  target: string,
  field: string,
  operator: string,
  value?: number,
  compareField?: string,
): RegimeBucketCondition {
  const c: RegimeBucketCondition = { type, target, field, operator } as RegimeBucketCondition;
  if (value !== undefined) c.value = value;
  if (compareField !== undefined) c.compareField = compareField;
  return c;
}

function validConfig(overrides?: Partial<RegimeConfigMap>): RegimeConfigMap {
  const base: RegimeConfigMap = {
    quadrants: [
      {
        key: 'bull',
        label: '强多头',
        action: 'trade',
        match: [matchCond('index', '000001.SH', 'macd', 'gt', 0)],
        entryConditions: [cond('brick', 'gt', 0)],
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
        match: [matchCond('index', '000001.SH', 'dif', 'lte', 0)],
      },
    ],
  };
  return { ...base, ...overrides };
}

function expectFail(config: unknown, message: string): void {
  expect(() => validateRegimeConfig(config)).toThrow(message);
}

describe('validateRegimeConfig', () => {
  it('合法配置通过', () => {
    expect(() => validateRegimeConfig(validConfig())).not.toThrow();
  });

  it('config 非对象 / 含未知键', () => {
    expectFail(null, 'config 必须为对象');
    expectFail({}, 'config.quadrants 必须为非空数组');
    expectFail(
      { quadrants: validConfig().quadrants, extra: 1 },
      '未知键',
    );
    expect(() =>
      validateRegimeConfig({
        quadrants: validConfig().quadrants,
        marketIndex: '000001.SH',
      }),
    ).not.toThrow();
  });

  it('quadrants 非法', () => {
    expectFail({}, 'config.quadrants 必须为非空数组');
    expectFail({ quadrants: [] }, 'config.quadrants 必须为非空数组');
    expectFail({ quadrants: 'x' }, 'config.quadrants 必须为非空数组');
  });

  it('quadrant key 非法', () => {
    const cfg = validConfig();
    cfg.quadrants[0].key = '';
    expectFail(cfg, 'key 必须为非空字符串');

    cfg.quadrants[0].key = '非法 key!';
    expectFail(cfg, '只能包含英文、数字、下划线、连字符');

    cfg.quadrants[0].key = 'bear';
    expectFail(cfg, '在配置内重复');

    delete (cfg.quadrants[0] as Partial<QuadrantEntry>).key;
    expectFail(cfg, 'key 必须为非空字符串');
  });

  it('quadrant label 非法', () => {
    const cfg = validConfig();
    cfg.quadrants[0].label = '';
    expectFail(cfg, 'label 必须为非空字符串');
    cfg.quadrants[0].label = '   ';
    expectFail(cfg, 'label 必须为非空字符串');
  });

  it('quadrant match 非法', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [];
    expectFail(cfg, 'match 必须为非空数组');

    cfg.quadrants[0].match = [matchCond('index', '000001.SH', 'unknown_field', 'gt', 0)];
    expectFail(cfg, '不在允许字段白名单');

    cfg.quadrants[0].match = [matchCond('stock', '000001.SZ', 'oamv_dif', 'gt', 0)];
    expectFail(cfg, '不在允许字段白名单');

    cfg.quadrants[0].match = [{ type: 'index', target: '000001.SH', field: 'macd', operator: 'gt' }];
    expectFail(cfg, 'value 在 compareMode=value/未指定时必须为有效数字');

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'invalid', value: 0 } as any,
    ];
    expectFail(cfg, 'operator 非法');

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', compareMode: 'field', compareField: 'unknown_field' } as any,
    ];
    expectFail(cfg, 'compareField 在 compareMode=field 时必须为非空且命中白名单字段');

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', compareMode: 'field' } as any,
    ];
    expectFail(cfg, 'compareField 在 compareMode=field 时必须为非空且命中白名单字段');

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', compareMode: 'field', compareField: 'unknown_field' } as any,
    ];
    expectFail(cfg, 'compareField 在 compareMode=field 时必须为非空且命中白名单字段');

    cfg.quadrants[0].match = [matchCond('crypto' as any, '000001.SH', 'macd', 'gt', 0)];
    expectFail(cfg, 'type 非法');

    cfg.quadrants[0].match = [matchCond('index', '', 'macd', 'gt', 0)];
    expectFail(cfg, 'target 必须为非空字符串');

    cfg.quadrants[0].match = [{ target: '000001.SH', field: 'macd', operator: 'gt', value: 0 } as any];
    expectFail(cfg, 'type 非法');

    cfg.quadrants[0].match = [{ type: 'index', field: 'macd', operator: 'gt', value: 0 } as any];
    expectFail(cfg, 'target 必须为非空字符串');

    cfg.quadrants[0].match = [{ type: 'index', target: '000001.SH', operator: 'gt', value: 0 } as any];
    expectFail(cfg, '不在允许字段白名单');
  });

  it('quadrant match compareMode 严格二选一', () => {
    const cfg = validConfig();

    cfg.quadrants[0].match = [matchCond('index', '000001.SH', 'macd', 'gt', 0)];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', compareMode: 'field', compareField: 'close' } as any,
    ];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', compareMode: 'value', value: 0 } as any,
    ];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', compareMode: 'field', compareField: 'close', value: 123 } as any,
    ];
    expectFail(cfg, 'value 在 compareMode=field 时必须为 null/undefined');

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', compareMode: 'value', value: 0, compareField: 'close' } as any,
    ];
    expectFail(cfg, 'compareField 在 compareMode=value/未指定时必须为 null/undefined');

    cfg.quadrants[0].match = [matchCond('index', '000001.SH', 'macd', 'gt', 0, 'close')];
    expectFail(cfg, 'compareField 在 compareMode=value/未指定时必须为 null/undefined');

    cfg.quadrants[0].match = [
      { type: 'index', target: '000001.SH', field: 'macd', operator: 'gt', compareMode: 'field', compareField: '' } as any,
    ];
    expectFail(cfg, 'compareField 在 compareMode=field 时必须为非空且命中白名单字段');
  });

  it('quadrant match 支持个股实际可求值字段', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [matchCond('stock', '000001.SZ', 'close', 'gt', 0)];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();

    cfg.quadrants[0].match = [matchCond('stock', '000001.SZ', 'macd_dif', 'cross_above', 0)];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('quadrant match 个股字段 list_days 不被 evaluator 支持', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [matchCond('stock', '000001.SZ', 'list_days', 'gt', 0)];
    expectFail(cfg, '不在允许字段白名单');

    cfg.quadrants[0].match = [
      {
        type: 'stock',
        target: '000001.SZ',
        field: 'macd_dif',
        operator: 'gt',
        compareMode: 'field',
        compareField: 'list_days',
      } as any,
    ];
    expectFail(cfg, 'compareField 在 compareMode=field 时必须为非空且命中白名单字段');
  });

  it('action 非法', () => {
    const cfg = validConfig();
    (cfg.quadrants[0] as any).action = 'hold';
    expectFail(cfg, 'action 非法');
  });

  it('trade 象限 entryConditions 非法', () => {
    const cfg = validConfig();
    cfg.quadrants[0].entryConditions = [];
    expectFail(cfg, 'entryConditions 必须为非空数组');

    cfg.quadrants[0].entryConditions = [cond('unknown', 'gt', 0)];
    expectFail(cfg, 'entryConditions[0].field');
  });

  it('trade 象限 exitMode/exitParams 非法', () => {
    let cfg = validConfig();
    (cfg.quadrants[0] as any).exitMode = 'unknown';
    expectFail(cfg, 'exitMode 非法');

    cfg = validConfig();
    cfg.quadrants[0].exitMode = 'fixed_n';
    cfg.quadrants[0].exitParams = {};
    expectFail(cfg, 'exitParams.N 必须为 >0 的数字');

    cfg = validConfig();
    cfg.quadrants[0].exitMode = 'strategy';
    cfg.quadrants[0].exitParams = { exitConditions: [], maxHold: 20 };
    expectFail(cfg, 'exitParams.exitConditions 必须为非空数组');

    cfg = validConfig();
    cfg.quadrants[0].exitMode = 'strategy';
    cfg.quadrants[0].exitParams = { exitConditions: [cond('brick', 'gt', 0)] };
    expectFail(cfg, 'exitParams.maxHold 必须为 >0 的数字');

    cfg = validConfig();
    cfg.quadrants[0].exitMode = 'trailing_lock';
    cfg.quadrants[0].exitParams = { maxHold: -1 };
    expectFail(cfg, 'exitParams.maxHold 必须为 >0');
  });

  it('flat 象限 trade 字段必须为 null', () => {
    const cfg = validConfig();
    cfg.quadrants[1].entryConditions = [cond('brick', 'gt', 0)];
    expectFail(cfg, 'action=flat 时 entryConditions 必须为 null');

    cfg.quadrants[1].entryConditions = null as any;
    (cfg.quadrants[1] as any).exitMode = 'fixed_n';
    expectFail(cfg, 'action=flat 时 exitMode 必须为 null');
  });

  it('合法 trailing_lock maxHold 为 null', () => {
    const cfg = validConfig();
    cfg.quadrants[0].exitMode = 'trailing_lock';
    cfg.quadrants[0].exitParams = { maxHold: null };
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('positionRatio 非法', () => {
    const cfg = validConfig();
    cfg.quadrants[0].positionRatio = 1.5;
    expectFail(cfg, 'positionRatio 必须为 (0, 1] 之间的数字');

    cfg.quadrants[0].positionRatio = -0.1;
    expectFail(cfg, 'positionRatio 必须为 (0, 1] 之间的数字');

    cfg.quadrants[0].positionRatio = 0;
    expectFail(cfg, 'positionRatio 必须为 (0, 1] 之间的数字');

    cfg.quadrants[0].positionRatio = '0.5' as any;
    expectFail(cfg, 'positionRatio 必须为 (0, 1] 之间的数字');
  });

  it('maxPositions 非法', () => {
    const cfg = validConfig();
    cfg.quadrants[0].maxPositions = 0;
    expectFail(cfg, 'maxPositions 必须为正整数');

    cfg.quadrants[0].maxPositions = 1.5;
    expectFail(cfg, 'maxPositions 必须为正整数');

    cfg.quadrants[0].maxPositions = -1;
    expectFail(cfg, 'maxPositions 必须为正整数');
  });

  it('trade 象限 positionRatio/maxPositions 必填', () => {
    const cfg = validConfig();
    cfg.quadrants[0].positionRatio = null;
    expectFail(cfg, 'positionRatio 必须为 (0, 1] 之间的数字');

    cfg.quadrants[0].positionRatio = 0.5;
    cfg.quadrants[0].maxPositions = null;
    expectFail(cfg, 'maxPositions 必须为正整数');

    delete (cfg.quadrants[0] as Partial<QuadrantEntry>).positionRatio;
    delete (cfg.quadrants[0] as Partial<QuadrantEntry>).maxPositions;
    expectFail(cfg, 'positionRatio 必须为 (0, 1] 之间的数字');
  });

  it('trade 象限 r*maxN > 1 拒绝', () => {
    const cfg = validConfig();
    cfg.quadrants[0].positionRatio = 0.3;
    cfg.quadrants[0].maxPositions = 4;
    expectFail(cfg, 'positionRatio * maxPositions 不能大于 1');
  });

  it('flat 象限可不要求仓位字段', () => {
    const cfg = validConfig();
    delete (cfg.quadrants[1] as Partial<QuadrantEntry>).positionRatio;
    delete (cfg.quadrants[1] as Partial<QuadrantEntry>).maxPositions;
    expect(() => validateRegimeConfig(cfg)).not.toThrow();

    cfg.quadrants[1].positionRatio = null;
    cfg.quadrants[1].maxPositions = null;
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('trailing_lock stopRatio 非法', () => {
    const cfg = validConfig();
    cfg.quadrants[0].exitMode = 'trailing_lock';
    cfg.quadrants[0].exitParams = { stopRatio: 1.5 };
    expectFail(cfg, 'exitParams.stopRatio 必须为 (0, 1] 之间的数字');

    cfg.quadrants[0].exitParams = { floorRatio: 0 };
    expectFail(cfg, 'exitParams.floorRatio 必须为 (0, 1] 之间的数字');

    cfg.quadrants[0].exitParams = { floorEnabled: 'yes' as any };
    expectFail(cfg, 'exitParams.floorEnabled 必须为 boolean');

    cfg.quadrants[0].exitParams = { ma5RequireDown: 1 as any };
    expectFail(cfg, 'exitParams.ma5RequireDown 必须为 boolean');
  });

  it('trailing_lock 合法全参通过', () => {
    const cfg = validConfig();
    cfg.quadrants[0].exitMode = 'trailing_lock';
    cfg.quadrants[0].exitParams = {
      maxHold: null,
      stopRatio: 0.999,
      floorRatio: 0.999,
      floorEnabled: true,
      ma5RequireDown: true,
    };
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('trailing_lock 缺省字段可用默认语义通过', () => {
    const cfg = validConfig();
    cfg.quadrants[0].exitMode = 'trailing_lock';
    cfg.quadrants[0].exitParams = {};
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('单象限允许空 match（通配）', () => {
    const cfg: RegimeConfigMap = {
      quadrants: [
        {
          key: 'solo',
          label: '唯一象限',
          action: 'trade',
          match: [],
          entryConditions: [cond('brick', 'gt', 0)],
          exitMode: 'fixed_n',
          exitParams: { N: 5 },
          positionRatio: 0.5,
          maxPositions: 2,
          rankField: 'turnover_rate',
          rankDir: 'desc',
        },
      ],
    };
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('单象限空 match 但 match 项非法仍报错', () => {
    const cfg: RegimeConfigMap = {
      quadrants: [
        {
          key: 'solo',
          label: '唯一',
          action: 'trade',
          match: [matchCond('index', '000001.SH', 'unknown_field', 'gt', 0)],
          entryConditions: [cond('brick', 'gt', 0)],
          exitMode: 'fixed_n',
          exitParams: { N: 5 },
          positionRatio: 0.5,
          maxPositions: 2,
          rankField: 'turnover_rate',
          rankDir: 'desc',
        },
      ],
    };
    expectFail(cfg, '不在允许字段白名单');
  });

  it('多象限下空 match 仍非法（回归）', () => {
    const cfg = validConfig(); // 双象限
    cfg.quadrants[0].match = [];
    expectFail(cfg, 'match 必须为非空数组');
  });

  it('trade 象限 rankField 必填', () => {
    const cfg = validConfig();
    delete (cfg.quadrants[0] as Partial<QuadrantEntry>).rankField;
    expectFail(cfg, 'rankField');
  });

  it('trade rankField 非法 → fail', () => {
    const cfg = validConfig();
    cfg.quadrants[0].rankField = 'oamv_macd';
    expectFail(cfg, 'rankField');
  });

  it('trade rankField≠none 缺 rankDir → fail', () => {
    const cfg = validConfig();
    cfg.quadrants[0].rankField = 'turnover_rate';
    cfg.quadrants[0].rankDir = null;
    expectFail(cfg, 'rankDir');
  });

  it('trade rankField=none 可不要求 rankDir', () => {
    const cfg = validConfig();
    cfg.quadrants[0].rankField = 'none';
    cfg.quadrants[0].rankDir = null;
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('flat 带非法 rankField 不校验（原样保留）', () => {
    const cfg = validConfig();
    cfg.quadrants[1].rankField = 'garbage';
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('universe.mode=symbols 合法', () => {
    const cfg = validConfig();
    cfg.universe = { mode: 'symbols', symbols: ['000001.SZ'] };
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('universe.mode=watchlist 缺 watchlistId → fail', () => {
    const cfg = validConfig();
    cfg.universe = { mode: 'watchlist' };
    expectFail(cfg, 'watchlistId');
  });

  it('universe.mode=symbols 空 symbols → fail', () => {
    const cfg = validConfig();
    cfg.universe = { mode: 'symbols', symbols: [] };
    expectFail(cfg, 'symbols');
  });
});

describe('checkQuadrantOverlapWarnings', () => {
  it('无重叠返回空', () => {
    const qs = validConfig().quadrants;
    expect(checkQuadrantOverlapWarnings(qs)).toEqual([]);
  });

  it('检测到相同条件时返回警告', () => {
    const qs: QuadrantEntry[] = [
      {
        key: 'A',
        label: 'A',
        action: 'flat',
        match: [matchCond('index', '000001.SH', 'macd', 'gt', 0)],
      },
      {
        key: 'B',
        label: 'B',
        action: 'flat',
        match: [matchCond('index', '000001.SH', 'macd', 'gt', 0), matchCond('index', '000001.SH', 'dif', 'lt', 0)],
      },
    ];
    const warnings = checkQuadrantOverlapWarnings(qs);
    expect(warnings.length).toBe(1);
    expect(warnings[0].message).toContain('A');
    expect(warnings[0].message).toContain('B');
  });

  it('不同 target 不视为重叠', () => {
    const qs: QuadrantEntry[] = [
      {
        key: 'A',
        label: 'A',
        action: 'flat',
        match: [matchCond('index', '000001.SH', 'macd', 'gt', 0)],
      },
      {
        key: 'B',
        label: 'B',
        action: 'flat',
        match: [matchCond('index', '399001.SZ', 'macd', 'gt', 0)],
      },
    ];
    expect(checkQuadrantOverlapWarnings(qs)).toEqual([]);
  });
});

describe('isDerivedField', () => {
  it('MA 各种周期返回 true', () => {
    expect(isDerivedField('ma5')).toBe(true);    // 预算列(合法但不现算)
    expect(isDerivedField('ma20')).toBe(true);   // 现算
    expect(isDerivedField('ma10')).toBe(true);
    expect(isDerivedField('ma15')).toBe(true);
    expect(isDerivedField('ma999')).toBe(true);
    expect(isDerivedField('ma30')).toBe(true);   // 预算列
    expect(isDerivedField('ma60')).toBe(true);   // 预算列
    expect(isDerivedField('ma120')).toBe(true);  // 预算列
    expect(isDerivedField('ma240')).toBe(true);  // 预算列
  });

  it('KDJ 三字段返回 true', () => {
    expect(isDerivedField('kdj_j')).toBe(true);
    expect(isDerivedField('kdj_k')).toBe(true);
    expect(isDerivedField('kdj_d')).toBe(true);
  });

  it('非现算字段返回 false', () => {
    expect(isDerivedField('close')).toBe(false);
    expect(isDerivedField('turnover_rate')).toBe(false);
    expect(isDerivedField('pct_chg')).toBe(false);
    expect(isDerivedField('brick')).toBe(false);
    expect(isDerivedField('foobar')).toBe(false);
    expect(isDerivedField('ma')).toBe(false);          // 无数字后缀
    expect(isDerivedField('ma_20')).toBe(false);      // 含下划线
    expect(isDerivedField('kdj_x')).toBe(false);      // 非 j/k/d
    expect(isDerivedField('kdj_j_extra')).toBe(false); // 后缀
  });

  it('非字符串输入返回 false', () => {
    expect(isDerivedField(undefined as any)).toBe(false);
    expect(isDerivedField(null as any)).toBe(false);
    expect(isDerivedField(42 as any)).toBe(false);
    expect(isDerivedField({} as any)).toBe(false);
  });
});

describe('validateRegimeConfig — derived field 白名单', () => {
  it('entryConditions 含 ma20 现算字段通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[0].entryConditions = [cond('ma20', 'gt', 3000)];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('entryConditions 含 ma10 现算字段通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[0].entryConditions = [cond('ma10', 'cross_above', 0)];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('entryConditions 含 kdj_j 通过校验(预算列字段,但 isDerivedField 也匹配)', () => {
    const cfg = validConfig();
    cfg.quadrants[0].entryConditions = [cond('kdj_j', 'lt', 0)];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('entryConditions 含 compareField=ma20 通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[0].entryConditions = [
      { field: 'close', operator: 'gt', compareField: 'ma20', compareMode: 'field' } as any,
    ];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('exitConditions 含 ma20 现算字段通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[0].exitMode = 'strategy';
    cfg.quadrants[0].exitParams = { exitConditions: [cond('ma20', 'lt', 2500)], maxHold: 10 };
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('entryConditions 含乱写字段仍被拒', () => {
    const cfg = validConfig();
    cfg.quadrants[0].entryConditions = [cond('foobar', 'gt', 0)];
    expectFail(cfg, '不在允许字段白名单');
  });

  it('entryConditions 含 ma(无数字)被拒', () => {
    const cfg = validConfig();
    cfg.quadrants[0].entryConditions = [cond('ma', 'gt', 0)];
    expectFail(cfg, '不在允许字段白名单');
  });

  it('rankField=ma20 通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[0].rankField = 'ma20';
    cfg.quadrants[0].rankDir = 'desc';
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('rankField=ma10 通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[0].rankField = 'ma10';
    cfg.quadrants[0].rankDir = 'asc';
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('rankField=乱写字段仍被拒', () => {
    const cfg = validConfig();
    cfg.quadrants[0].rankField = 'garbage_ma';
    expectFail(cfg, 'rankField');
  });

  it('纯预算字段 config 回归:既有用例仍通过', () => {
    expect(() => validateRegimeConfig(validConfig())).not.toThrow();
  });
});

function mg(logic: 'and' | 'or', items: MatchNode[]): MatchGroup {
  return { logic, items };
}

describe('validateRegimeConfig — MatchGroup 嵌套条件', () => {
  it('含 MatchGroup 的 config 通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [
      mg('or', [
        mg('and', [
          matchCond('index', '000001.SH', 'macd', 'lt', 0),
          matchCond('index', '000001.SH', 'dif', 'gt', 0),
        ]),
        mg('and', [
          matchCond('index', '000001.SH', 'macd', 'gt', 0),
          matchCond('index', '000001.SH', 'dif', 'lt', 0),
        ]),
      ]),
    ];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('MatchGroup logic 非法被拒', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [
      { logic: 'xor', items: [] } as any,
    ];
    expectFail(cfg, 'logic 非法');
  });

  it('MatchGroup items 为空被拒', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [
      mg('and', []),
    ];
    expectFail(cfg, 'items 必须为非空数组');
  });

  it('MatchGroup items 非数组被拒', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [
      { logic: 'and', items: 'bad' } as any,
    ];
    expectFail(cfg, 'items 必须为非空数组');
  });

  it('MatchGroup 内叶子条件非法仍被拒', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [
      mg('and', [
        matchCond('index', '000001.SH', 'unknown_field', 'gt', 0),
      ]),
    ];
    expectFail(cfg, '不在允许字段白名单');
  });

  it('MatchGroup 内嵌套 MatchGroup 的叶子条件非法被拒', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [
      mg('or', [
        mg('and', [
          matchCond('index', '000001.SH', 'macd', 'gt', 0),
          mg('and', [
            matchCond('index', '000001.SH', 'bad_field', 'gt', 0),
          ]),
        ]),
      ]),
    ];
    expectFail(cfg, '不在允许字段白名单');
  });

  it('嵌套深度 > 5 被拒', () => {
    const cfg = validConfig();
    // 构造 7 层包装 → validateMatchGroup 从 depth=0 开始,最深 leaf 被包裹 7 次 → depth=6 > 5
    let node: MatchNode = matchCond('index', '000001.SH', 'macd', 'gt', 0);
    for (let i = 0; i < 7; i++) {
      node = mg('and', [node]);
    }
    cfg.quadrants[0].match = [node];
    expectFail(cfg, '嵌套深度超过 5 层');
  });

  it('嵌套深度 = 5 通过校验', () => {
    const cfg = validConfig();
    // 构造 6 层包装 → 最深 depth=5, 恰好不触发 > 5
    let node: MatchNode = matchCond('index', '000001.SH', 'macd', 'gt', 0);
    for (let i = 0; i < 6; i++) {
      node = mg('and', [node]);
    }
    cfg.quadrants[0].match = [node];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('match 混合叶子 + MatchGroup 通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[0].match = [
      matchCond('index', '000001.SH', 'close', 'gt', 3000),
      mg('or', [
        matchCond('index', '000001.SH', 'dif', 'lt', 0),
        matchCond('index', '000001.SH', 'dea', 'lt', 0),
      ]),
    ];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });

  it('flat 象限含 MatchGroup 通过校验', () => {
    const cfg = validConfig();
    cfg.quadrants[1].match = [
      mg('or', [
        matchCond('index', '000001.SH', 'macd', 'lt', 0),
        matchCond('index', '000001.SH', 'dif', 'lt', 0),
      ]),
    ];
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
  });
});
