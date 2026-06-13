import { describe, it, expect } from 'vitest';
import { getFieldDescription, FIELD_DESCRIPTIONS } from './fieldDescriptions';
import {
  A_SHARE_FIELDS,
  CRYPTO_FIELDS,
} from '../strategy-conditions/conditionFieldMeta';

/**
 * 一看就懂、不写说明（也就不显示 "?"）的条件字段 value。
 * 其余条件字段都应在 FIELD_DESCRIPTIONS 里有非空说明，防漏配 / 拼写漂移。
 */
const OBVIOUS_FIELDS = new Set([
  'ma5',
  'ma30',
  'ma60',
  'ma120',
  'ma240',
  'close',
  'open',
  'high',
  'low',
  'volume',
  'amount',
  'pct_chg',
  'list_days',
]);

describe('getFieldDescription', () => {
  it('对需要解释的字段返回非空说明', () => {
    for (const concept of ['pos_120', 'oamv_close', 'kdj_j', 'macd_hist', 'profit_loss_ratio']) {
      const desc = getFieldDescription(concept);
      expect(desc, concept).toBeTruthy();
      expect(typeof desc).toBe('string');
    }
  });

  it('对直观字段与未知/空 key 返回 undefined', () => {
    expect(getFieldDescription('ma5')).toBeUndefined();
    expect(getFieldDescription('close')).toBeUndefined();
    expect(getFieldDescription('not_a_field')).toBeUndefined();
    expect(getFieldDescription(undefined)).toBeUndefined();
    expect(getFieldDescription('')).toBeUndefined();
  });
});

describe('字典覆盖守门', () => {
  const allFieldValues = [...new Set([...A_SHARE_FIELDS, ...CRYPTO_FIELDS].map((f) => f.value))];

  it('每个非直观的条件字段 value 都有说明（conceptId 与 field value 对齐）', () => {
    const missing = allFieldValues
      .filter((v) => !OBVIOUS_FIELDS.has(v))
      .filter((v) => !getFieldDescription(v));
    expect(missing, `以下条件字段缺说明: ${missing.join(', ')}`).toEqual([]);
  });

  it('字典里无空字符串说明', () => {
    const empty = Object.entries(FIELD_DESCRIPTIONS)
      .filter(([, v]) => !v || !v.trim())
      .map(([k]) => k);
    expect(empty, `以下 conceptId 说明为空: ${empty.join(', ')}`).toEqual([]);
  });
});
