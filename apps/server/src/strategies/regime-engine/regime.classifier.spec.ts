/**
 * regime.classifier.spec.ts
 *
 * 单测：0AMV 四象限纯函数分类器。
 * 口径（与研究侧离线 SQL 完全一致，边界 <= 归负侧）：
 *   dif>0 且 macd>0  → Q1
 *   dif>0 且 macd<=0 → Q2
 *   dif<=0 且 macd>0 → Q3
 *   dif<=0 且 macd<=0 → Q4
 *   任一入参 null / 非有限数 → unknown
 */
import { classifyRegime } from './regime.classifier';

describe('classifyRegime', () => {
  describe('四象限基本矩阵', () => {
    it('dif>0 且 macd>0 → Q1', () => {
      expect(classifyRegime(1.5, 0.3)).toBe('Q1');
    });

    it('dif>0 且 macd<0 → Q2', () => {
      expect(classifyRegime(1.5, -0.3)).toBe('Q2');
    });

    it('dif<0 且 macd>0 → Q3', () => {
      expect(classifyRegime(-1.5, 0.3)).toBe('Q3');
    });

    it('dif<0 且 macd<0 → Q4', () => {
      expect(classifyRegime(-1.5, -0.3)).toBe('Q4');
    });
  });

  describe('边界值（0 归负侧）', () => {
    it('dif>0 且 macd=0 → Q2（macd 边界归负侧）', () => {
      expect(classifyRegime(1.5, 0)).toBe('Q2');
    });

    it('dif=0 且 macd>0 → Q3（dif 边界归负侧）', () => {
      expect(classifyRegime(0, 0.3)).toBe('Q3');
    });

    it('dif=0 且 macd=0 → Q4', () => {
      expect(classifyRegime(0, 0)).toBe('Q4');
    });

    it('dif=0 且 macd<0 → Q4', () => {
      expect(classifyRegime(0, -0.3)).toBe('Q4');
    });

    it('dif<0 且 macd=0 → Q4', () => {
      expect(classifyRegime(-1.5, 0)).toBe('Q4');
    });
  });

  describe('null / 非有限数 → unknown', () => {
    it('dif=null → unknown', () => {
      expect(classifyRegime(null, 0.3)).toBe('unknown');
    });

    it('macd=null → unknown', () => {
      expect(classifyRegime(1.5, null)).toBe('unknown');
    });

    it('双 null → unknown', () => {
      expect(classifyRegime(null, null)).toBe('unknown');
    });

    it('dif=NaN → unknown', () => {
      expect(classifyRegime(NaN, 0.3)).toBe('unknown');
    });

    it('macd=NaN → unknown', () => {
      expect(classifyRegime(1.5, NaN)).toBe('unknown');
    });

    it('dif=Infinity → unknown', () => {
      expect(classifyRegime(Infinity, 0.3)).toBe('unknown');
    });

    it('macd=-Infinity → unknown', () => {
      expect(classifyRegime(1.5, -Infinity)).toBe('unknown');
    });

    it('undefined（运行时脏入参）→ unknown', () => {
      expect(classifyRegime(undefined as unknown as number, 0.3)).toBe('unknown');
    });
  });
});
