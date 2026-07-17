import { NumericTransformer } from './numeric.transformer';

describe('NumericTransformer', () => {
  let transformer: NumericTransformer;

  beforeEach(() => {
    transformer = new NumericTransformer();
  });

  describe('from (DB → entity)', () => {
    it('字符串 numeric 正确解析为 number', () => {
      expect(transformer.from('15512888.02248082')).toBe(15512888.02248082);
      expect(transformer.from('0.5513')).toBe(0.5513);
      expect(transformer.from('-0.235')).toBe(-0.235);
      expect(transformer.from('0')).toBe(0);
    });

    it('number 入参原样返回', () => {
      expect(transformer.from(15512888.02)).toBe(15512888.02);
      expect(transformer.from(0)).toBe(0);
      expect(transformer.from(-0.235)).toBe(-0.235);
    });

    it('null / undefined / 空字符串 返回 null', () => {
      expect(transformer.from(null)).toBeNull();
      expect(transformer.from(undefined)).toBeNull();
      expect(transformer.from('')).toBeNull();
    });

    it('非数字字符串返回 null', () => {
      expect(transformer.from('abc')).toBeNull();
      expect(transformer.from('NaN')).toBeNull();
      expect(transformer.from('12.34.56')).toBeNull();
    });

    it('字符串 Infinity / -Infinity 返回 null（避免 Number.isFinite 误判）', () => {
      expect(transformer.from('Infinity')).toBeNull();
      expect(transformer.from('-Infinity')).toBeNull();
      expect(transformer.from('1e400')).toBeNull(); // 溢出到 Infinity
    });

    it('科学计数法字符串正确解析', () => {
      expect(transformer.from('1.5e3')).toBe(1500);
      expect(transformer.from('1.5E-3')).toBe(0.0015);
    });
  });

  describe('to (entity → DB)', () => {
    it('number 原样透传', () => {
      expect(transformer.to(15512888.02)).toBe(15512888.02);
      expect(transformer.to(0)).toBe(0);
      expect(transformer.to(-0.235)).toBe(-0.235);
    });

    it('string 兼容透传（历史调用路径）', () => {
      // to 不强制转换，保留原值让 PG driver 处理
      expect(transformer.to('15512888.02')).toBe('15512888.02');
    });

    it('null / undefined 返回 null', () => {
      expect(transformer.to(null)).toBeNull();
      expect(transformer.to(undefined)).toBeNull();
    });
  });
});
