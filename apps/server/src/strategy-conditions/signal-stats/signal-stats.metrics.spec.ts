/**
 * signal-stats.metrics.spec.ts
 *
 * 指标聚合纯函数单测（TDD — 先写测试，再写实现）。
 * 所有用例均附手算注释，浮点断言用 toBeCloseTo(value, precision)。
 */

import { calcSignalStats } from './signal-stats.metrics';

describe('calcSignalStats', () => {
  // ─────────────────────────────────────────────
  // 1. 正常混合样本
  // ─────────────────────────────────────────────
  describe('正常混合：rets=[0.1, 0.1, -0.05], holdDays=[1, 1, 1]', () => {
    /**
     * 手算：
     *   N = 3
     *   wins  = [0.1, 0.1]   losses = [-0.05]
     *   p     = 2/3
     *   avgWin = 0.1,  avgLoss = -0.05
     *   b     = 0.1 / 0.05 = 2
     *   PF    = (0.1+0.1) / 0.05 = 4
     *   f*    = 2/3 − (1/3)/2 = 2/3 − 1/6 = 1/2 = 0.5
     *   avgHoldDays = 1,  worstTradeRet = -0.05
     */
    const result = calcSignalStats([0.1, 0.1, -0.05], [1, 1, 1]);

    it('sampleCount = 3', () => expect(result.sampleCount).toBe(3));
    it('winRate ≈ 2/3', () => expect(result.winRate).toBeCloseTo(2 / 3, 10));
    it('avgWin ≈ 0.1', () => expect(result.avgWin).toBeCloseTo(0.1, 10));
    it('avgLoss ≈ -0.05', () => expect(result.avgLoss).toBeCloseTo(-0.05, 10));
    it('payoffRatio ≈ 2', () => expect(result.payoffRatio).toBeCloseTo(2, 10));
    it('profitFactor ≈ 4', () => expect(result.profitFactor).toBeCloseTo(4, 10));
    it('kellyF ≈ 0.5', () => expect(result.kellyF).toBeCloseTo(0.5, 10));
    it('avgHoldDays ≈ 1', () => expect(result.avgHoldDays).toBeCloseTo(1, 10));
    it('worstTradeRet ≈ -0.05', () => expect(result.worstTradeRet).toBeCloseTo(-0.05, 10));
  });

  // ─────────────────────────────────────────────
  // 2. 无亏损样本（losses 为空）
  // ─────────────────────────────────────────────
  describe('无亏损样本：rets=[0.1, 0.2], holdDays=[2, 3]', () => {
    /**
     * 手算：
     *   N = 2,  wins = [0.1, 0.2],  losses = []
     *   p = 1,  avgWin = 0.15,  avgLoss = null
     *   b = null（avgLoss 无法计算）
     *   PF = null（losses 空 → 无亏损样本标记）
     *   f* = null（b 不可用）
     *   avgHoldDays = 2.5,  worstTradeRet = 0.1
     */
    const result = calcSignalStats([0.1, 0.2], [2, 3]);

    it('sampleCount = 2', () => expect(result.sampleCount).toBe(2));
    it('winRate = 1', () => expect(result.winRate).toBeCloseTo(1, 10));
    it('avgWin ≈ 0.15', () => expect(result.avgWin).toBeCloseTo(0.15, 10));
    it('avgLoss = null', () => expect(result.avgLoss).toBeNull());
    it('payoffRatio = null', () => expect(result.payoffRatio).toBeNull());
    it('profitFactor = null', () => expect(result.profitFactor).toBeNull());
    it('kellyF = null', () => expect(result.kellyF).toBeNull());
    it('avgHoldDays ≈ 2.5', () => expect(result.avgHoldDays).toBeCloseTo(2.5, 10));
    it('worstTradeRet ≈ 0.1', () => expect(result.worstTradeRet).toBeCloseTo(0.1, 10));
  });

  // ─────────────────────────────────────────────
  // 3. 全亏（wins 为空）
  // ─────────────────────────────────────────────
  describe('全亏：rets=[-0.1, -0.2], holdDays=[1, 2]', () => {
    /**
     * 手算：
     *   N = 2,  wins = [],  losses = [-0.1, -0.2]
     *   p = 0,  avgWin = null,  avgLoss = -0.15
     *   b = null（avgWin 无样本）
     *   PF = Σwins / |Σlosses| = 0 / 0.3 = 0
     *   f* = null（b 不可用）
     *   avgHoldDays = 1.5,  worstTradeRet = -0.2
     */
    const result = calcSignalStats([-0.1, -0.2], [1, 2]);

    it('sampleCount = 2', () => expect(result.sampleCount).toBe(2));
    it('winRate = 0', () => expect(result.winRate).toBeCloseTo(0, 10));
    it('avgWin = null', () => expect(result.avgWin).toBeNull());
    it('avgLoss ≈ -0.15', () => expect(result.avgLoss).toBeCloseTo(-0.15, 10));
    it('payoffRatio = null', () => expect(result.payoffRatio).toBeNull());
    it('profitFactor = 0', () => expect(result.profitFactor).toBeCloseTo(0, 10));
    it('kellyF = null', () => expect(result.kellyF).toBeNull());
    it('avgHoldDays ≈ 1.5', () => expect(result.avgHoldDays).toBeCloseTo(1.5, 10));
    it('worstTradeRet ≈ -0.2', () => expect(result.worstTradeRet).toBeCloseTo(-0.2, 10));
  });

  // ─────────────────────────────────────────────
  // 4. N=0（空数组）
  // ─────────────────────────────────────────────
  describe('N=0：空数组', () => {
    const result = calcSignalStats([], []);

    it('sampleCount = 0', () => expect(result.sampleCount).toBe(0));
    it('winRate = null', () => expect(result.winRate).toBeNull());
    it('avgWin = null', () => expect(result.avgWin).toBeNull());
    it('avgLoss = null', () => expect(result.avgLoss).toBeNull());
    it('payoffRatio = null', () => expect(result.payoffRatio).toBeNull());
    it('profitFactor = null', () => expect(result.profitFactor).toBeNull());
    it('kellyF = null', () => expect(result.kellyF).toBeNull());
    it('avgHoldDays = null', () => expect(result.avgHoldDays).toBeNull());
    it('worstTradeRet = null', () => expect(result.worstTradeRet).toBeNull());
  });

  // ─────────────────────────────────────────────
  // 5. 含 ret=0 的样本
  // ─────────────────────────────────────────────
  describe('含 ret=0：rets=[0.1, 0, -0.05], holdDays=[2, 3, 4]', () => {
    /**
     * 手算：
     *   N = 3（ret=0 计入 N）
     *   wins  = [0.1]  losses = [-0.05]  （ret=0 不计入 wins/losses）
     *   p = 1/3
     *   avgWin = 0.1,  avgLoss = -0.05
     *   b = 0.1 / 0.05 = 2
     *   PF = 0.1 / 0.05 = 2
     *   f* = 1/3 − (2/3)/2 = 1/3 − 1/3 = 0
     *   avgHoldDays = (2+3+4)/3 = 3
     *   worstTradeRet = -0.05
     */
    const result = calcSignalStats([0.1, 0, -0.05], [2, 3, 4]);

    it('sampleCount = 3', () => expect(result.sampleCount).toBe(3));
    it('winRate ≈ 1/3', () => expect(result.winRate).toBeCloseTo(1 / 3, 10));
    it('avgWin ≈ 0.1', () => expect(result.avgWin).toBeCloseTo(0.1, 10));
    it('avgLoss ≈ -0.05', () => expect(result.avgLoss).toBeCloseTo(-0.05, 10));
    it('payoffRatio ≈ 2', () => expect(result.payoffRatio).toBeCloseTo(2, 10));
    it('profitFactor ≈ 2', () => expect(result.profitFactor).toBeCloseTo(2, 10));
    it('kellyF ≈ 0', () => expect(result.kellyF).toBeCloseTo(0, 10));
    it('avgHoldDays ≈ 3', () => expect(result.avgHoldDays).toBeCloseTo(3, 10));
    it('worstTradeRet ≈ -0.05', () => expect(result.worstTradeRet).toBeCloseTo(-0.05, 10));
  });

  // ─────────────────────────────────────────────
  // 6. worstTradeRet = min(rets)
  // ─────────────────────────────────────────────
  describe('worstTradeRet 取 min', () => {
    it('多笔中最小值', () => {
      // rets = [0.3, -0.1, 0.05, -0.25, 0.0]
      // min = -0.25
      const result = calcSignalStats([0.3, -0.1, 0.05, -0.25, 0.0], [1, 1, 1, 1, 1]);
      expect(result.worstTradeRet).toBeCloseTo(-0.25, 10);
    });

    it('全正时 worstTradeRet 为最小正数', () => {
      const result = calcSignalStats([0.5, 0.1, 0.3], [1, 1, 1]);
      expect(result.worstTradeRet).toBeCloseTo(0.1, 10);
    });
  });

  // ─────────────────────────────────────────────
  // 7. 边界：全零收益（ret=0 全部不计入 wins/losses）
  // ─────────────────────────────────────────────
  describe('全零收益：rets=[0, 0], holdDays=[1, 2]', () => {
    /**
     * 手算：
     *   N = 2,  wins = [],  losses = []
     *   p = 0/2 = 0,  avgWin = null,  avgLoss = null
     *   b = null,  PF = null（losses 空）,  f* = null
     *   avgHoldDays = 1.5,  worstTradeRet = 0
     */
    const result = calcSignalStats([0, 0], [1, 2]);

    it('sampleCount = 2', () => expect(result.sampleCount).toBe(2));
    it('winRate = 0', () => expect(result.winRate).toBeCloseTo(0, 10));
    it('avgWin = null', () => expect(result.avgWin).toBeNull());
    it('avgLoss = null', () => expect(result.avgLoss).toBeNull());
    it('payoffRatio = null', () => expect(result.payoffRatio).toBeNull());
    it('profitFactor = null', () => expect(result.profitFactor).toBeNull());
    it('kellyF = null', () => expect(result.kellyF).toBeNull());
    it('avgHoldDays ≈ 1.5', () => expect(result.avgHoldDays).toBeCloseTo(1.5, 10));
    it('worstTradeRet = 0', () => expect(result.worstTradeRet).toBeCloseTo(0, 10));
  });

  // ─────────────────────────────────────────────
  // 8. 无副作用：多次调用同参数结果一致
  // ─────────────────────────────────────────────
  it('纯函数无副作用，同参数多次调用结果一致', () => {
    const rets = [0.1, -0.05, 0.2, -0.1];
    const holdDays = [1, 2, 3, 4];
    const r1 = calcSignalStats(rets, holdDays);
    const r2 = calcSignalStats(rets, holdDays);
    expect(r1).toEqual(r2);
  });
});
