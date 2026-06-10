/**
 * regime-engine.validation.spec.ts
 *
 * 单测：regime 配置 fail-fast 校验（400 并指明字段）。
 * 覆盖：缺象限键 / 未知键 / 非法 action / field 不在白名单 / fixed_n 缺 N /
 *       strategy 缺 exitConditions 或 maxHold / trailing_lock maxHold 非法 /
 *       flat 带条件 等典型用例 + 白名单构成抽查。
 */
import { BadRequestException } from '@nestjs/common';
import {
  ASHARE_CONDITION_FIELD_WHITELIST,
  validateRegimeConfig,
} from './regime-engine.validation';

// ── fixture 工厂 ────────────────────────────────────────────────────────────

function flatEntry(): Record<string, unknown> {
  return {
    action: 'flat',
    label: '空头',
    entryConditions: null,
    exitMode: null,
    exitParams: null,
  };
}

function tradeEntry(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    action: 'trade',
    label: '反弹筑底',
    entryConditions: [{ field: 'macd_hist', operator: 'gt', value: 0 }],
    exitMode: 'trailing_lock',
    exitParams: { maxHold: null },
    ...overrides,
  };
}

function validConfig(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    Q1: tradeEntry(),
    Q2: flatEntry(),
    Q3: tradeEntry(),
    Q4: flatEntry(),
    ...overrides,
  };
}

function expectFail(config: unknown, msgPattern: RegExp): void {
  expect(() => validateRegimeConfig(config)).toThrow(BadRequestException);
  expect(() => validateRegimeConfig(config)).toThrow(msgPattern);
}

// ── 测试套件 ────────────────────────────────────────────────────────────────

describe('validateRegimeConfig', () => {
  describe('合法配置', () => {
    it('四象限齐全（trade trailing_lock + flat）→ 通过', () => {
      expect(() => validateRegimeConfig(validConfig())).not.toThrow();
    });

    it('fixed_n 带 N>0 → 通过', () => {
      const cfg = validConfig({
        Q1: tradeEntry({ exitMode: 'fixed_n', exitParams: { N: 5 } }),
      });
      expect(() => validateRegimeConfig(cfg)).not.toThrow();
    });

    it('strategy 带 exitConditions+maxHold → 通过', () => {
      const cfg = validConfig({
        Q1: tradeEntry({
          exitMode: 'strategy',
          exitParams: {
            exitConditions: [{ field: 'kdj_j', operator: 'gt', value: 90 }],
            maxHold: 10,
          },
        }),
      });
      expect(() => validateRegimeConfig(cfg)).not.toThrow();
    });

    it('trailing_lock 带 maxHold>0（非 null）→ 通过', () => {
      const cfg = validConfig({
        Q1: tradeEntry({ exitParams: { maxHold: 20 } }),
      });
      expect(() => validateRegimeConfig(cfg)).not.toThrow();
    });

    it('入场条件含行业/大盘 AMV 字段 → 通过', () => {
      const cfg = validConfig({
        Q1: tradeEntry({
          entryConditions: [
            { field: 'ind_amv_macd', operator: 'gt', value: 0 },
            { field: 'oamv_dif', operator: 'gt', value: 0 },
          ],
        }),
      });
      expect(() => validateRegimeConfig(cfg)).not.toThrow();
    });
  });

  describe('整体结构', () => {
    it('非对象 → 400', () => {
      expectFail(null, /config 必须为对象/);
      expectFail([], /config 必须为对象/);
      expectFail('Q1', /config 必须为对象/);
    });

    it('缺象限键 Q3 → 400 指明 Q3', () => {
      const cfg = validConfig();
      delete cfg.Q3;
      expectFail(cfg, /缺少象限 Q3/);
    });

    it('含未知键 q5 → 400', () => {
      expectFail(validConfig({ q5: flatEntry() }), /未知键 "q5"/);
    });

    it('象限条目非对象 → 400', () => {
      expectFail(validConfig({ Q2: 'flat' }), /Q2/);
    });
  });

  describe('action', () => {
    it('action 非法（hold）→ 400 指明字段', () => {
      expectFail(
        validConfig({ Q1: tradeEntry({ action: 'hold' }) }),
        /Q1\.action 非法/,
      );
    });

    it('action 缺失 → 400', () => {
      const entry = tradeEntry();
      delete entry.action;
      expectFail(validConfig({ Q1: entry }), /Q1\.action 非法/);
    });
  });

  describe('trade 象限', () => {
    it('entryConditions 为空数组 → 400', () => {
      expectFail(
        validConfig({ Q1: tradeEntry({ entryConditions: [] }) }),
        /Q1\.entryConditions 必须为非空数组/,
      );
    });

    it('entryConditions 为 null → 400', () => {
      expectFail(
        validConfig({ Q1: tradeEntry({ entryConditions: null }) }),
        /Q1\.entryConditions 必须为非空数组/,
      );
    });

    it('field 不在白名单 → 400 指明字段名', () => {
      expectFail(
        validConfig({
          Q1: tradeEntry({
            entryConditions: [{ field: 'not_a_field', operator: 'gt', value: 0 }],
          }),
        }),
        /not_a_field.*不在条件系统字段白名单/,
      );
    });

    it('exitMode 非法 → 400', () => {
      expectFail(
        validConfig({ Q1: tradeEntry({ exitMode: 'hold_forever' }) }),
        /Q1\.exitMode 非法/,
      );
    });

    it('exitParams 非对象 → 400', () => {
      expectFail(
        validConfig({ Q1: tradeEntry({ exitParams: null }) }),
        /Q1\.exitParams 必须为对象/,
      );
    });

    it('fixed_n 缺 N → 400', () => {
      expectFail(
        validConfig({ Q1: tradeEntry({ exitMode: 'fixed_n', exitParams: {} }) }),
        /Q1\.exitParams\.N/,
      );
    });

    it('fixed_n N<=0 → 400', () => {
      expectFail(
        validConfig({ Q1: tradeEntry({ exitMode: 'fixed_n', exitParams: { N: 0 } }) }),
        /Q1\.exitParams\.N/,
      );
    });

    it('strategy 缺 exitConditions → 400', () => {
      expectFail(
        validConfig({
          Q1: tradeEntry({ exitMode: 'strategy', exitParams: { maxHold: 10 } }),
        }),
        /Q1\.exitParams\.exitConditions/,
      );
    });

    it('strategy 缺 maxHold → 400', () => {
      expectFail(
        validConfig({
          Q1: tradeEntry({
            exitMode: 'strategy',
            exitParams: {
              exitConditions: [{ field: 'kdj_j', operator: 'gt', value: 90 }],
            },
          }),
        }),
        /Q1\.exitParams\.maxHold/,
      );
    });

    it('strategy exitConditions 的 field 也走白名单 → 400', () => {
      expectFail(
        validConfig({
          Q1: tradeEntry({
            exitMode: 'strategy',
            exitParams: {
              exitConditions: [{ field: 'bogus', operator: 'gt', value: 0 }],
              maxHold: 10,
            },
          }),
        }),
        /bogus.*不在条件系统字段白名单/,
      );
    });

    it('trailing_lock maxHold=-1 → 400（可 null 但不可非法数）', () => {
      expectFail(
        validConfig({ Q1: tradeEntry({ exitParams: { maxHold: -1 } }) }),
        /Q1\.exitParams\.maxHold/,
      );
    });
  });

  describe('flat 象限', () => {
    it('flat 带 entryConditions → 400', () => {
      const entry = flatEntry();
      entry.entryConditions = [{ field: 'macd_hist', operator: 'gt', value: 0 }];
      expectFail(validConfig({ Q2: entry }), /Q2.*entryConditions 必须为 null/);
    });

    it('flat 带 exitMode → 400', () => {
      const entry = flatEntry();
      entry.exitMode = 'fixed_n';
      expectFail(validConfig({ Q2: entry }), /Q2.*exitMode 必须为 null/);
    });

    it('flat 的策略字段缺省（undefined）→ 通过（等价 null）', () => {
      const cfg = validConfig({ Q2: { action: 'flat', label: '空头' } });
      expect(() => validateRegimeConfig(cfg)).not.toThrow();
    });
  });

  describe('白名单构成', () => {
    it('含三个 map 的代表性键（个股/行业/大盘）', () => {
      for (const f of ['macd_hist', 'kdj_j', 'close', 'list_days', 'ind_amv_dif', 'oamv_macd']) {
        expect(ASHARE_CONDITION_FIELD_WHITELIST.has(f)).toBe(true);
      }
    });

    it('不含 crypto 专有键与杜撰键', () => {
      expect(ASHARE_CONDITION_FIELD_WHITELIST.has('quote_volume')).toBe(false);
      expect(ASHARE_CONDITION_FIELD_WHITELIST.has('nonexistent')).toBe(false);
    });
  });
});
