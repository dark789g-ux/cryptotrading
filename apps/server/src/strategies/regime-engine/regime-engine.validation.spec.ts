/**
 * regime-engine.validation.spec.ts
 *
 * regime 配置校验单测（v3 分桶条件）。
 */
import {
  validateRegimeConfig,
  checkQuadrantOverlapWarnings,
} from './regime-engine.validation';
import {
  QuadrantEntry,
  RegimeBucketCondition,
  RegimeConfigMap,
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
        positionRatio: 0.5,
        maxPositions: 10,
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
    expectFail(
      { quadrants: validConfig().quadrants, marketIndex: '000001.SH' },
      '未知键',
    );
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
    expectFail(cfg, 'positionRatio 必须为 null 或 0~1 之间的数字');

    cfg.quadrants[0].positionRatio = -0.1;
    expectFail(cfg, 'positionRatio 必须为 null 或 0~1 之间的数字');

    cfg.quadrants[0].positionRatio = '0.5' as any;
    expectFail(cfg, 'positionRatio 必须为 null 或 0~1 之间的数字');
  });

  it('maxPositions 非法', () => {
    const cfg = validConfig();
    cfg.quadrants[0].maxPositions = 0;
    expectFail(cfg, 'maxPositions 必须为 null 或正整数');

    cfg.quadrants[0].maxPositions = 1.5;
    expectFail(cfg, 'maxPositions 必须为 null 或正整数');

    cfg.quadrants[0].maxPositions = -1;
    expectFail(cfg, 'maxPositions 必须为 null 或正整数');
  });

  it('positionRatio / maxPositions 为 null 通过', () => {
    const cfg = validConfig();
    cfg.quadrants[0].positionRatio = null;
    cfg.quadrants[0].maxPositions = null;
    expect(() => validateRegimeConfig(cfg)).not.toThrow();
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
