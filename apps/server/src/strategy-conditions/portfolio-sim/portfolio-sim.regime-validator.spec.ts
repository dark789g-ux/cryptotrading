/**
 * portfolio-sim.regime-validator.spec.ts
 *
 * 共享 regime 校验器单测（spec §7）。两处 DTO 复用同一 validateRegimes：
 *   - 组合模拟 create dto（config.regimes）
 *   - 迷你回测 validateBacktestConfig（backtestConfig.regimes）
 *
 * 规则：
 *   - regimes 缺省 / null → 不校验（零漂移）。
 *   - 每条 RegimeRule.conditions 非空数组。
 *   - 每项 field ∈ {oamv_dif,oamv_dea,oamv_macd,oamv_close,oamv_ma240}。
 *   - operator ∈ {gt,lt,gte,lte,eq,neq}（禁 cross_above/cross_below）。
 *   - 有 compareField → 它也在白名单；否则 value 须有限数。
 *   - maxPositions 正整数；positionRatio ∈ (0,1]。
 *   - 非法 → BadRequestException（中文消息，含 tag 前缀）。
 */

import { BadRequestException } from '@nestjs/common';
import { validateRegimes } from './portfolio-sim.regime-validator';
import { RegimeRule } from './portfolio-sim.types';

const TAG = 'config.regimes';

function rule(overrides: Partial<RegimeRule> = {}): RegimeRule {
  return {
    conditions: [{ field: 'oamv_macd', operator: 'gt', value: 0 }],
    maxPositions: 2,
    positionRatio: 0.45,
    ...overrides,
  };
}

describe('validateRegimes — 缺省零漂移', () => {
  it('undefined 不抛', () => {
    expect(() => validateRegimes(undefined, TAG)).not.toThrow();
  });
  it('null 不抛', () => {
    expect(() => validateRegimes(null, TAG)).not.toThrow();
  });
  it('空数组合法（= 不启用）', () => {
    expect(() => validateRegimes([], TAG)).not.toThrow();
  });
});

describe('validateRegimes — 合法 canonical', () => {
  it('两条规则（柱>0&dif>0 / 柱<0&dif>0）全合法', () => {
    const regimes: RegimeRule[] = [
      {
        conditions: [
          { field: 'oamv_macd', operator: 'gt', value: 0 },
          { field: 'oamv_dif', operator: 'gt', value: 0 },
        ],
        maxPositions: 2,
        positionRatio: 0.45,
      },
      {
        conditions: [
          { field: 'oamv_macd', operator: 'lt', value: 0 },
          { field: 'oamv_dif', operator: 'gt', value: 0 },
        ],
        maxPositions: 5,
        positionRatio: 0.2,
      },
    ];
    expect(() => validateRegimes(regimes, TAG)).not.toThrow();
  });

  it('compareField 字段比较（close lt ma240）合法', () => {
    const regimes: RegimeRule[] = [
      rule({
        conditions: [{ field: 'oamv_close', operator: 'lt', compareField: 'oamv_ma240' }],
      }),
    ];
    expect(() => validateRegimes(regimes, TAG)).not.toThrow();
  });

  it('positionRatio=1 边界合法', () => {
    expect(() => validateRegimes([rule({ positionRatio: 1 })], TAG)).not.toThrow();
  });

  it('全部 operator（gt/gte/lt/lte/eq/neq）合法', () => {
    const ops: RegimeRule['conditions'][number]['operator'][] = [
      'gt', 'gte', 'lt', 'lte', 'eq', 'neq',
    ];
    for (const op of ops) {
      expect(() =>
        validateRegimes([rule({ conditions: [{ field: 'oamv_dif', operator: op, value: 0 }] })], TAG),
      ).not.toThrow();
    }
  });
});

describe('validateRegimes — 结构非法', () => {
  it('非数组 → 抛', () => {
    expect(() => validateRegimes({} as never, TAG)).toThrow(BadRequestException);
  });
  it('规则非对象 → 抛', () => {
    expect(() => validateRegimes([null as never], TAG)).toThrow(BadRequestException);
  });
  it('conditions 非数组 → 抛', () => {
    expect(() => validateRegimes([rule({ conditions: 'x' as never })], TAG)).toThrow(
      BadRequestException,
    );
  });
  it('conditions 空数组 → 抛', () => {
    expect(() => validateRegimes([rule({ conditions: [] })], TAG)).toThrow(BadRequestException);
  });
  it('条件项非对象 → 抛', () => {
    expect(() => validateRegimes([rule({ conditions: [null as never] })], TAG)).toThrow(
      BadRequestException,
    );
  });
});

describe('validateRegimes — 字段白名单', () => {
  it('field 不在白名单 → 抛', () => {
    expect(() =>
      validateRegimes([rule({ conditions: [{ field: 'rsi', operator: 'gt', value: 0 }] })], TAG),
    ).toThrow(BadRequestException);
  });
  it('compareField 不在白名单 → 抛', () => {
    expect(() =>
      validateRegimes(
        [rule({ conditions: [{ field: 'oamv_close', operator: 'lt', compareField: 'rsi' }] })],
        TAG,
      ),
    ).toThrow(BadRequestException);
  });
});

describe('validateRegimes — operator', () => {
  it('禁 cross_above → 抛', () => {
    expect(() =>
      validateRegimes(
        [rule({ conditions: [{ field: 'oamv_dif', operator: 'cross_above' as never, value: 0 }] })],
        TAG,
      ),
    ).toThrow(BadRequestException);
  });
  it('禁 cross_below → 抛', () => {
    expect(() =>
      validateRegimes(
        [rule({ conditions: [{ field: 'oamv_dif', operator: 'cross_below' as never, value: 0 }] })],
        TAG,
      ),
    ).toThrow(BadRequestException);
  });
  it('未知 operator → 抛', () => {
    expect(() =>
      validateRegimes(
        [rule({ conditions: [{ field: 'oamv_dif', operator: 'between' as never, value: 0 }] })],
        TAG,
      ),
    ).toThrow(BadRequestException);
  });
});

describe('validateRegimes — value / compareField', () => {
  it('无 compareField 且 value 缺失 → 抛', () => {
    expect(() =>
      validateRegimes([rule({ conditions: [{ field: 'oamv_dif', operator: 'gt' }] })], TAG),
    ).toThrow(BadRequestException);
  });
  it('value 非有限数（NaN）→ 抛', () => {
    expect(() =>
      validateRegimes([rule({ conditions: [{ field: 'oamv_dif', operator: 'gt', value: NaN }] })], TAG),
    ).toThrow(BadRequestException);
  });
  it('value 非数（字符串）→ 抛', () => {
    expect(() =>
      validateRegimes(
        [rule({ conditions: [{ field: 'oamv_dif', operator: 'gt', value: '1' as never }] })],
        TAG,
      ),
    ).toThrow(BadRequestException);
  });
  it('有 compareField 时 value 缺失合法（字段 vs 字段）', () => {
    expect(() =>
      validateRegimes(
        [rule({ conditions: [{ field: 'oamv_close', operator: 'gt', compareField: 'oamv_ma240' }] })],
        TAG,
      ),
    ).not.toThrow();
  });
});

describe('validateRegimes — maxPositions', () => {
  it('非整数 → 抛', () => {
    expect(() => validateRegimes([rule({ maxPositions: 2.5 })], TAG)).toThrow(BadRequestException);
  });
  it('0 → 抛', () => {
    expect(() => validateRegimes([rule({ maxPositions: 0 })], TAG)).toThrow(BadRequestException);
  });
  it('负数 → 抛', () => {
    expect(() => validateRegimes([rule({ maxPositions: -1 })], TAG)).toThrow(BadRequestException);
  });
  it('null（无「不限仓」档）→ 抛', () => {
    expect(() => validateRegimes([rule({ maxPositions: null as never })], TAG)).toThrow(
      BadRequestException,
    );
  });
});

describe('validateRegimes — positionRatio', () => {
  it('0 → 抛', () => {
    expect(() => validateRegimes([rule({ positionRatio: 0 })], TAG)).toThrow(BadRequestException);
  });
  it('>1 → 抛', () => {
    expect(() => validateRegimes([rule({ positionRatio: 1.5 })], TAG)).toThrow(BadRequestException);
  });
  it('负数 → 抛', () => {
    expect(() => validateRegimes([rule({ positionRatio: -0.1 })], TAG)).toThrow(BadRequestException);
  });
  it('非数 → 抛', () => {
    expect(() => validateRegimes([rule({ positionRatio: 'x' as never })], TAG)).toThrow(
      BadRequestException,
    );
  });
});

describe('validateRegimes — tag 前缀进消息', () => {
  it('消息含传入 tag（backtestConfig.regimes）', () => {
    try {
      validateRegimes([rule({ maxPositions: 0 })], 'backtestConfig.regimes');
      fail('应抛');
    } catch (e) {
      expect((e as Error).message).toContain('backtestConfig.regimes');
    }
  });
});
