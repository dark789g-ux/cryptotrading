import { BadRequestException } from '@nestjs/common';
import {
  ALLOWED_RUN_TYPES,
  KELLY_SWEEP_ALLOWED_BASE_FIELDS,
  validateCreateJob,
} from '../../dto/create-job.dto';

/**
 * kelly_sweep DTO 校验单测。
 * 覆盖 spec 04 § DTO params 校验 + KELLY_SWEEP_ALLOWED_BASE_FIELDS 白名单。
 */

/** 构造一个完整合法的 kelly_sweep body */
function validBody(overrides: Record<string, unknown> = {}) {
  return {
    run_type: 'kelly_sweep',
    params: {
      base_trigger: { field: 'kdj_j', op: 'lt', value: 0.0 },
      universe: 'all',
      max_window: 20,
      max_entry_filters: 1,
      min_samples: 300,
      train_range: ['20230101', '20241231'],
      valid_range: ['20250101', '20260608'],
      bootstrap_iters: 1000,
      same_day_rule: 'sl_first',
      rs_benchmark: ['hs300', 'zz500'],
      rs_lookback: 5,
      top_k: 30,
      exit_families: ['fixed_n', 'tp_sl', 'trailing', 'atr_stop'],
      ...overrides,
    },
  };
}

describe('ALLOWED_RUN_TYPES 包含 kelly_sweep', () => {
  it('ALLOWED_RUN_TYPES 包含 kelly_sweep', () => {
    expect(ALLOWED_RUN_TYPES).toContain('kelly_sweep');
  });
});

describe('KELLY_SWEEP_ALLOWED_BASE_FIELDS 白名单', () => {
  it('包含 kdj_j / macd / rsi_6 / atr_14 等预期成员', () => {
    expect(KELLY_SWEEP_ALLOWED_BASE_FIELDS.has('kdj_j')).toBe(true);
    expect(KELLY_SWEEP_ALLOWED_BASE_FIELDS.has('macd')).toBe(true);
    expect(KELLY_SWEEP_ALLOWED_BASE_FIELDS.has('rsi_6')).toBe(true);
    expect(KELLY_SWEEP_ALLOWED_BASE_FIELDS.has('atr_14')).toBe(true);
    expect(KELLY_SWEEP_ALLOWED_BASE_FIELDS.has('ema20')).toBe(true);
  });

  it('共 29 个成员（与 enumerate.py:57 对齐）', () => {
    // kdj_k/d/j, macd/dif/dea, rsi6/12/24, cci, dmi_pdi/mdi/adx/adxr,
    // boll_upper/mid/lower, ma5/10/20/30/60, atr_14, obv, wr, bias, ema5/10/20
    expect(KELLY_SWEEP_ALLOWED_BASE_FIELDS.size).toBe(29);
  });

  it('不包含 industry（非指标字段）', () => {
    expect(KELLY_SWEEP_ALLOWED_BASE_FIELDS.has('industry')).toBe(false);
  });

  it('不包含 close（不在白名单）', () => {
    expect(KELLY_SWEEP_ALLOWED_BASE_FIELDS.has('close')).toBe(false);
  });
});

describe('validateCreateJob kelly_sweep — 通过路径', () => {
  it('完整合法 body → 通过，runType=kelly_sweep', () => {
    const out = validateCreateJob(validBody());
    expect(out.runType).toBe('kelly_sweep');
    expect(out.params.base_trigger).toBeDefined();
  });

  it('universe=[] string 数组 → 通过', () => {
    const out = validateCreateJob(validBody({ universe: ['000001.SZ', '000002.SZ'] }));
    expect(out.runType).toBe('kelly_sweep');
  });

  it('max_entry_filters=0 → 通过（下界=0）', () => {
    const out = validateCreateJob(validBody({ max_entry_filters: 0 }));
    expect(out.runType).toBe('kelly_sweep');
  });

  it('same_day_rule=tp_first → 通过', () => {
    const out = validateCreateJob(validBody({ same_day_rule: 'tp_first' }));
    expect(out.runType).toBe('kelly_sweep');
  });

  it('rs_benchmark 只含 hs300 → 通过', () => {
    const out = validateCreateJob(validBody({ rs_benchmark: ['hs300'] }));
    expect(out.runType).toBe('kelly_sweep');
  });

  it('exit_families 只含 fixed_n → 通过', () => {
    const out = validateCreateJob(validBody({ exit_families: ['fixed_n'] }));
    expect(out.runType).toBe('kelly_sweep');
  });

  it('train_start == valid_start → 通过（边界相等合法）', () => {
    const out = validateCreateJob(
      validBody({ train_range: ['20230101', '20241231'], valid_range: ['20230101', '20260101'] }),
    );
    expect(out.runType).toBe('kelly_sweep');
  });
});

describe('validateCreateJob kelly_sweep — base_trigger 校验', () => {
  it('base_trigger.field 非白名单 → BadRequestException', () => {
    expect(() =>
      validateCreateJob(validBody({ base_trigger: { field: 'industry', op: 'lt', value: 0 } })),
    ).toThrow(BadRequestException);
  });

  it('base_trigger.field=close（非白名单）→ BadRequestException', () => {
    expect(() =>
      validateCreateJob(validBody({ base_trigger: { field: 'close', op: 'lt', value: 0 } })),
    ).toThrow(BadRequestException);
  });

  it('base_trigger.op 非枚举 → BadRequestException', () => {
    expect(() =>
      validateCreateJob(
        validBody({ base_trigger: { field: 'kdj_j', op: 'between', value: 0 } }),
      ),
    ).toThrow(BadRequestException);
  });

  it('base_trigger.value 非数字 → BadRequestException', () => {
    expect(() =>
      validateCreateJob(
        validBody({ base_trigger: { field: 'kdj_j', op: 'lt', value: 'zero' } }),
      ),
    ).toThrow(BadRequestException);
  });

  it('base_trigger 缺失 → BadRequestException', () => {
    expect(() => {
      const body = validBody();
      delete (body.params as Record<string, unknown>).base_trigger;
      return validateCreateJob(body);
    }).toThrow(BadRequestException);
  });
});

describe('validateCreateJob kelly_sweep — 日期区间校验', () => {
  it('train_range[0] > train_range[1] → BadRequestException', () => {
    expect(() =>
      validateCreateJob(validBody({ train_range: ['20241231', '20230101'] })),
    ).toThrow(BadRequestException);
  });

  it('valid_range[0] > valid_range[1] → BadRequestException', () => {
    expect(() =>
      validateCreateJob(validBody({ valid_range: ['20260608', '20250101'] })),
    ).toThrow(BadRequestException);
  });

  it('train_start > valid_start → BadRequestException', () => {
    // train_range[0]='20250201' > valid_range[0]='20250101'
    expect(() =>
      validateCreateJob(
        validBody({ train_range: ['20250201', '20250531'], valid_range: ['20250101', '20260101'] }),
      ),
    ).toThrow(BadRequestException);
  });

  it('train_range 格式非 YYYYMMDD → BadRequestException', () => {
    expect(() =>
      validateCreateJob(validBody({ train_range: ['2023-01-01', '20241231'] })),
    ).toThrow(BadRequestException);
  });

  it('train_range 非二元组 → BadRequestException', () => {
    expect(() =>
      validateCreateJob(validBody({ train_range: ['20230101'] })),
    ).toThrow(BadRequestException);
  });
});

describe('validateCreateJob kelly_sweep — 数值下界', () => {
  for (const [field, minVal] of [
    ['max_window', 1],
    ['min_samples', 1],
    ['bootstrap_iters', 1],
    ['rs_lookback', 1],
    ['top_k', 1],
  ] as [string, number][]) {
    it(`${field}=${minVal - 1} → BadRequestException（下界 ${minVal}）`, () => {
      expect(() => validateCreateJob(validBody({ [field]: minVal - 1 }))).toThrow(
        BadRequestException,
      );
    });
    it(`${field}=${minVal} → 通过`, () => {
      const out = validateCreateJob(validBody({ [field]: minVal }));
      expect(out.runType).toBe('kelly_sweep');
    });
  }

  it('max_entry_filters=-1 → BadRequestException（下界 0）', () => {
    expect(() => validateCreateJob(validBody({ max_entry_filters: -1 }))).toThrow(
      BadRequestException,
    );
  });
});

describe('validateCreateJob kelly_sweep — rs_benchmark', () => {
  it('rs_benchmark 含 industry → BadRequestException（暂未接通）', () => {
    expect(() =>
      validateCreateJob(validBody({ rs_benchmark: ['industry'] })),
    ).toThrow(BadRequestException);
  });

  it('rs_benchmark 为空数组 → BadRequestException', () => {
    expect(() => validateCreateJob(validBody({ rs_benchmark: [] }))).toThrow(BadRequestException);
  });

  it('rs_benchmark 含未知成员 → BadRequestException', () => {
    expect(() =>
      validateCreateJob(validBody({ rs_benchmark: ['hs300', 'csi500'] })),
    ).toThrow(BadRequestException);
  });
});

describe('validateCreateJob kelly_sweep — exit_families', () => {
  it('exit_families 为空数组 → BadRequestException', () => {
    expect(() => validateCreateJob(validBody({ exit_families: [] }))).toThrow(BadRequestException);
  });

  it('exit_families 含未知成员 → BadRequestException', () => {
    expect(() =>
      validateCreateJob(validBody({ exit_families: ['fixed_n', 'unknown_exit'] })),
    ).toThrow(BadRequestException);
  });

  it('exit_families 全部合法成员 {fixed_n,tp_sl,trailing,atr_stop} → 通过', () => {
    const out = validateCreateJob(
      validBody({ exit_families: ['fixed_n', 'tp_sl', 'trailing', 'atr_stop'] }),
    );
    expect(out.runType).toBe('kelly_sweep');
  });
});

describe('validateCreateJob kelly_sweep — same_day_rule', () => {
  it('same_day_rule=invalid → BadRequestException', () => {
    expect(() => validateCreateJob(validBody({ same_day_rule: 'invalid_rule' }))).toThrow(
      BadRequestException,
    );
  });
});

describe('validateCreateJob kelly_sweep — universe', () => {
  it("universe=非 'all' 且非数组 → BadRequestException", () => {
    expect(() => validateCreateJob(validBody({ universe: 'some_index' }))).toThrow(
      BadRequestException,
    );
  });

  it('universe 含非字符串成员 → BadRequestException', () => {
    expect(() => validateCreateJob(validBody({ universe: [123, '000001.SZ'] }))).toThrow(
      BadRequestException,
    );
  });
});
