import { describe, expect, it } from 'vitest';
import {
  fieldValueToDisplay,
  fieldValueToStorage,
  formatConditionItem,
} from './conditionFieldMeta';

describe('conditionFieldMeta value conversion', () => {
  it('circ_mv: storage 万元 ↔ UI 亿', () => {
    expect(fieldValueToDisplay('circ_mv', 'a-share', 208_000)).toBe(20.8);
    expect(fieldValueToStorage('circ_mv', 'a-share', 20.8)).toBe(208_000);
  });

  it('circ_mv: 207641 万元 ≈ 20.7641 亿', () => {
    expect(fieldValueToDisplay('circ_mv', 'a-share', 207_641)).toBeCloseTo(20.7641, 4);
    expect(fieldValueToStorage('circ_mv', 'a-share', 20.7641)).toBeCloseTo(207_641, 0);
  });

  it('amount: storage 千元 ↔ UI 亿', () => {
    expect(fieldValueToDisplay('amount', 'a-share', 100_000)).toBe(1);
    expect(fieldValueToStorage('amount', 'a-share', 1)).toBe(100_000);
  });

  it('无 factor 字段透传', () => {
    expect(fieldValueToDisplay('turnover_rate', 'a-share', 2.5)).toBe(2.5);
    expect(fieldValueToStorage('turnover_rate', 'a-share', 2.5)).toBe(2.5);
  });

  it('formatConditionItem 摘要显示 UI 亿而非原始 storage', () => {
    const text = formatConditionItem(
      { field: 'circ_mv', operator: 'lt', value: 207_641, compareMode: 'value' },
      'a-share',
    );
    expect(text).toBe('流通市值 小于 20.7641');
    expect(text).not.toContain('207641');
  });
});
