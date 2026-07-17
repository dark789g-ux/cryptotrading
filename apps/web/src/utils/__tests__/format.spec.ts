import { describe, it, expect } from 'vitest';
import { toNum, fmtPct, fmtNum } from '../format';

describe('toNum', () => {
  it('number 入参原样返回', () => {
    expect(toNum(1.5)).toBe(1.5);
    expect(toNum(0)).toBe(0);
    expect(toNum(-0.235)).toBe(-0.235);
  });

  it('字符串 numeric 入参解析为 number', () => {
    expect(toNum('15512888.02248082')).toBe(15512888.02248082);
    expect(toNum('0.5513')).toBe(0.5513);
    expect(toNum('-0.235')).toBe(-0.235);
    expect(toNum('0')).toBe(0);
  });

  it('null / undefined / 空字符串 返回 null', () => {
    expect(toNum(null)).toBeNull();
    expect(toNum(undefined)).toBeNull();
    expect(toNum('')).toBeNull();
  });

  it('非数字字符串返回 null', () => {
    expect(toNum('abc')).toBeNull();
    expect(toNum('NaN')).toBeNull();
  });

  it('NaN / Infinity / -Infinity 返回 null', () => {
    expect(toNum(NaN)).toBeNull();
    expect(toNum(Infinity)).toBeNull();
    expect(toNum(-Infinity)).toBeNull();
  });
});

describe('fmtPct', () => {
  it('数字入参正确格式化', () => {
    expect(fmtPct(0.5513)).toBe('55.13%');
    expect(fmtPct(-0.235)).toBe('-23.50%');
    expect(fmtPct(0)).toBe('0.00%');
    expect(fmtPct(1)).toBe('100.00%');
  });

  it('字符串 numeric 入参也能格式化', () => {
    expect(fmtPct('0.5513')).toBe('55.13%');
    expect(fmtPct('-0.235')).toBe('-23.50%');
  });

  it('自定义小数位数', () => {
    expect(fmtPct(0.5513, 1)).toBe('55.1%');
    expect(fmtPct(0.5513, 4)).toBe('55.1300%');
  });

  it('无效入参返回 "-"', () => {
    expect(fmtPct(null)).toBe('-');
    expect(fmtPct(undefined)).toBe('-');
    expect(fmtPct('abc')).toBe('-');
    expect(fmtPct(NaN)).toBe('-');
  });
});

describe('fmtNum', () => {
  it('数字入参正确格式化', () => {
    expect(fmtNum(15512888.02248082, 2)).toBe('15512888.02');
    expect(fmtNum(0.7625)).toBe('0.76');
    expect(fmtNum(0)).toBe('0.00');
    expect(fmtNum(-100.5)).toBe('-100.50');
  });

  it('字符串 numeric 入参也能格式化', () => {
    expect(fmtNum('15512888.02248082', 2)).toBe('15512888.02');
    expect(fmtNum('0.7625')).toBe('0.76');
  });

  it('自定义小数位数', () => {
    expect(fmtNum(0.7625533, 4)).toBe('0.7626');
    expect(fmtNum(0.7625533, 0)).toBe('1');
  });

  it('无效入参返回 "-"', () => {
    expect(fmtNum(null)).toBe('-');
    expect(fmtNum(undefined)).toBe('-');
    expect(fmtNum('abc')).toBe('-');
    expect(fmtNum(Infinity)).toBe('-');
  });
});
