import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import {
  EXIT_RULE_TYPES,
  getExitRuleTypesMeta,
  validateCreateStrategy,
  validateExitRules,
} from '../dto/create-strategy.dto';

/**
 * create-strategy DTO 校验单测（spec 04 §4 / 02 §2）：
 *   - 顶层字段格式（strategy_id / strategy_version / name）→ 400
 *   - 5 种 type 的 params 范围（含开/闭区间边界）→ 422
 *   - 跨规则：非空 / 恰一条 max_hold / 每种 type 至多一条 → 422
 *   - exit-rule-types 元信息源
 */

/** 合法 max_hold 规则（多数用例需要它满足"恰含一条 max_hold"） */
const MAX_HOLD = { type: 'max_hold', params: { days: 20 } };

const base = {
  strategy_id: 'default_exit',
  strategy_version: 'v1',
  name: '默认出场策略',
};

describe('validateCreateStrategy：顶层字段', () => {
  it('合法最小体（仅 max_hold）→ 通过', () => {
    expect(() =>
      validateCreateStrategy({ ...base, exit_rules: [MAX_HOLD] }),
    ).not.toThrow();
  });

  it('strategy_id 含大写 → 400', () => {
    expect(() =>
      validateCreateStrategy({ ...base, strategy_id: 'Default', exit_rules: [MAX_HOLD] }),
    ).toThrow(BadRequestException);
  });

  it('strategy_id 含连字符 → 400', () => {
    expect(() =>
      validateCreateStrategy({ ...base, strategy_id: 'my-exit', exit_rules: [MAX_HOLD] }),
    ).toThrow(BadRequestException);
  });

  it('strategy_version 不匹配 /^v\\d+$/ → 400', () => {
    expect(() =>
      validateCreateStrategy({ ...base, strategy_version: '1', exit_rules: [MAX_HOLD] }),
    ).toThrow(BadRequestException);
  });

  it('name 为空 → 400', () => {
    expect(() =>
      validateCreateStrategy({ ...base, name: '', exit_rules: [MAX_HOLD] }),
    ).toThrow(BadRequestException);
  });

  it('name 超长（>100）→ 400', () => {
    expect(() =>
      validateCreateStrategy({ ...base, name: 'x'.repeat(101), exit_rules: [MAX_HOLD] }),
    ).toThrow(BadRequestException);
  });
});

describe('validateExitRules：params 范围（5 种 type）', () => {
  // 每条用例都补一条 max_hold 以满足跨规则；被测规则放第一位
  const withMaxHold = (rule: unknown) => [rule, MAX_HOLD];

  describe('stop_loss.pct ∈ (0,1) 开区间', () => {
    it('0.08 → 通过', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'stop_loss', params: { pct: 0.08 } }))).not.toThrow();
    });
    it('0（下界开）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'stop_loss', params: { pct: 0 } }))).toThrow(UnprocessableEntityException);
    });
    it('1（上界开）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'stop_loss', params: { pct: 1 } }))).toThrow(UnprocessableEntityException);
    });
    it('0.9999 → 通过', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'stop_loss', params: { pct: 0.9999 } }))).not.toThrow();
    });
    it('缺 pct → 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'stop_loss', params: {} }))).toThrow(UnprocessableEntityException);
    });
  });

  describe('ma_break.period int ∈ [2,250] 闭区间', () => {
    it('5 → 通过', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'ma_break', params: { period: 5 } }))).not.toThrow();
    });
    it('2（下界含）→ 通过', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'ma_break', params: { period: 2 } }))).not.toThrow();
    });
    it('250（上界含）→ 通过', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'ma_break', params: { period: 250 } }))).not.toThrow();
    });
    it('1（下界外）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'ma_break', params: { period: 1 } }))).toThrow(UnprocessableEntityException);
    });
    it('251（上界外）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'ma_break', params: { period: 251 } }))).toThrow(UnprocessableEntityException);
    });
    it('2.5（非整数）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'ma_break', params: { period: 2.5 } }))).toThrow(UnprocessableEntityException);
    });
  });

  describe('max_hold.days int ∈ [1,250] 闭区间', () => {
    it('20 → 通过', () => {
      expect(() => validateExitRules([{ type: 'max_hold', params: { days: 20 } }])).not.toThrow();
    });
    it('1（下界含）→ 通过', () => {
      expect(() => validateExitRules([{ type: 'max_hold', params: { days: 1 } }])).not.toThrow();
    });
    it('250（上界含）→ 通过', () => {
      expect(() => validateExitRules([{ type: 'max_hold', params: { days: 250 } }])).not.toThrow();
    });
    it('0（下界外）→ 422', () => {
      expect(() => validateExitRules([{ type: 'max_hold', params: { days: 0 } }])).toThrow(UnprocessableEntityException);
    });
    it('251（上界外）→ 422', () => {
      expect(() => validateExitRules([{ type: 'max_hold', params: { days: 251 } }])).toThrow(UnprocessableEntityException);
    });
    it('20.5（非整数）→ 422', () => {
      expect(() => validateExitRules([{ type: 'max_hold', params: { days: 20.5 } }])).toThrow(UnprocessableEntityException);
    });
  });

  describe('take_profit.pct ∈ (0,5] 半开区间', () => {
    it('0.15 → 通过', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'take_profit', params: { pct: 0.15 } }))).not.toThrow();
    });
    it('5（上界含）→ 通过', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'take_profit', params: { pct: 5 } }))).not.toThrow();
    });
    it('0（下界开）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'take_profit', params: { pct: 0 } }))).toThrow(UnprocessableEntityException);
    });
    it('5.1（上界外）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'take_profit', params: { pct: 5.1 } }))).toThrow(UnprocessableEntityException);
    });
  });

  describe('trailing_stop.pct ∈ (0,1) 开区间', () => {
    it('0.1 → 通过', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'trailing_stop', params: { pct: 0.1 } }))).not.toThrow();
    });
    it('1（上界开）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'trailing_stop', params: { pct: 1 } }))).toThrow(UnprocessableEntityException);
    });
    it('0（下界开）→ 422', () => {
      expect(() => validateExitRules(withMaxHold({ type: 'trailing_stop', params: { pct: 0 } }))).toThrow(UnprocessableEntityException);
    });
  });

  it('未知 type → 422', () => {
    expect(() => validateExitRules([{ type: 'unknown', params: {} }, MAX_HOLD])).toThrow(UnprocessableEntityException);
  });

  it('params 含多余字段 → 422', () => {
    expect(() => validateExitRules(withMaxHold({ type: 'stop_loss', params: { pct: 0.08, extra: 1 } }))).toThrow(UnprocessableEntityException);
  });
});

describe('validateExitRules：跨规则约束', () => {
  it('空数组 → 422', () => {
    expect(() => validateExitRules([])).toThrow(UnprocessableEntityException);
  });

  it('非数组 → 422', () => {
    expect(() => validateExitRules({} as unknown)).toThrow(UnprocessableEntityException);
  });

  it('无 max_hold → 422', () => {
    expect(() => validateExitRules([{ type: 'stop_loss', params: { pct: 0.08 } }])).toThrow(UnprocessableEntityException);
  });

  it('两条 max_hold → 422（恰一条）', () => {
    expect(() =>
      validateExitRules([
        { type: 'max_hold', params: { days: 10 } },
        { type: 'max_hold', params: { days: 20 } },
      ]),
    ).toThrow(UnprocessableEntityException);
  });

  it('同 type（非 max_hold）重复两条 → 422（每种至多一条）', () => {
    expect(() =>
      validateExitRules([
        { type: 'stop_loss', params: { pct: 0.05 } },
        { type: 'stop_loss', params: { pct: 0.08 } },
        MAX_HOLD,
      ]),
    ).toThrow(UnprocessableEntityException);
  });

  it('5 种 type 各一条（含 max_hold）→ 通过', () => {
    expect(() =>
      validateExitRules([
        { type: 'stop_loss', params: { pct: 0.08 } },
        { type: 'ma_break', params: { period: 5 } },
        { type: 'max_hold', params: { days: 20 } },
        { type: 'take_profit', params: { pct: 0.15 } },
        { type: 'trailing_stop', params: { pct: 0.1 } },
      ]),
    ).not.toThrow();
  });
});

describe('getExitRuleTypesMeta：后端范围单一真相源', () => {
  it('覆盖全部 5 种 type', () => {
    const meta = getExitRuleTypesMeta();
    expect(meta.map((m) => m.type).sort()).toEqual([...EXIT_RULE_TYPES].sort());
  });

  it('每种 type 恰一个 param，含范围/类型/默认值', () => {
    const meta = getExitRuleTypesMeta();
    for (const m of meta) {
      expect(m.params).toHaveLength(1);
      const p = m.params[0];
      expect(typeof p.name).toBe('string');
      expect(['float', 'int']).toContain(p.valueType);
      expect(typeof p.min).toBe('number');
      expect(typeof p.max).toBe('number');
      expect(typeof p.minInclusive).toBe('boolean');
      expect(typeof p.maxInclusive).toBe('boolean');
      expect(typeof p.default).toBe('number');
    }
  });

  it('stop_loss 范围为 (0,1) 开区间、默认 0.08', () => {
    const sl = getExitRuleTypesMeta().find((m) => m.type === 'stop_loss')!;
    const p = sl.params[0];
    expect(p).toMatchObject({ name: 'pct', valueType: 'float', min: 0, max: 1, minInclusive: false, maxInclusive: false, default: 0.08 });
  });

  it('take_profit 上界闭区间 (0,5]', () => {
    const tp = getExitRuleTypesMeta().find((m) => m.type === 'take_profit')!;
    expect(tp.params[0]).toMatchObject({ min: 0, max: 5, minInclusive: false, maxInclusive: true });
  });

  it('元信息默认值自身落在各自范围内（自洽）', () => {
    // 默认值喂回 validateExitRules（配 max_hold）应全部通过
    for (const m of getExitRuleTypesMeta()) {
      const rule = { type: m.type, params: { [m.params[0].name]: m.params[0].default } };
      const rules = m.type === 'max_hold' ? [rule] : [rule, MAX_HOLD];
      expect(() => validateExitRules(rules)).not.toThrow();
    }
  });
});
