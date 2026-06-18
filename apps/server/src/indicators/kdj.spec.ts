import { calcKdjSeries } from './kdj';

/** 构造一个简单、确定性的 K 线序列（high > low，便于手算验证）。 */
function buildAscendingBars(): Array<{ high: number; low: number; close: number }> {
  return [
    { high: 10, low: 8, close: 9 },
    { high: 11, low: 9, close: 10 },
    { high: 12, low: 10, close: 11 },
    { high: 13, low: 11, close: 12 },
    { high: 14, low: 12, close: 13 },
    { high: 15, low: 13, close: 14 },
    { high: 16, low: 14, close: 15 },
    { high: 17, low: 15, close: 16 },
    { high: 18, low: 16, close: 17 },
    { high: 19, low: 17, close: 18 },
  ];
}

describe('calcKdjSeries', () => {
  it('输出长度与输入长度一致', () => {
    const bars = buildAscendingBars();
    const result = calcKdjSeries(bars, 9, 3, 3);
    expect(result.length).toBe(bars.length);
  });

  it('默认 9/3/3 与自定义参数产生不同结果', () => {
    const bars = buildAscendingBars();
    const defaultResult = calcKdjSeries(bars, 9, 3, 3);
    const customResult = calcKdjSeries(bars, 6, 2, 2);

    expect(customResult[customResult.length - 1]).not.toEqual(
      defaultResult[defaultResult.length - 1],
    );
  });

  it('前 N-1 根因窗口不足仍按种子 50/50 计算（与现有行为一致）', () => {
    const bars = buildAscendingBars();
    const result = calcKdjSeries(bars, 9, 3, 3);

    // 第 0 根：窗口仅自身，RSV = (9-8)/(10-8)*100 = 50，K=D=50，J=50
    expect(result[0]).toEqual({ k: 50, d: 50, j: 50 });

    // 第 1 根：n=9 窗口仍不足，取 [0,1]；RSV = (10-8)/(11-8)*100 = 66.666...
    // k = (2*50 + 66.666...)/3 = 55.555...
    // d = (2*50 + 55.555...)/3 = 51.851...
    // j = 3*55.555... - 2*51.851... = 62.962...
    expect(result[1].k).toBeCloseTo(55.55555555555556, 10);
    expect(result[1].d).toBeCloseTo(51.851851851851855, 10);
    expect(result[1].j).toBeCloseTo(62.96296296296296, 10);
  });

  it('flat 行情（high === low）时 RSV 取 50，避免除零', () => {
    const bars = [
      { high: 10, low: 10, close: 10 },
      { high: 10, low: 10, close: 10 },
    ];
    const result = calcKdjSeries(bars, 9, 3, 3);
    expect(result.every((p) => p.k === 50 && p.d === 50 && p.j === 50)).toBe(true);
  });

  it('每根 J 都满足 J = 3K - 2D', () => {
    const bars = buildAscendingBars();
    const result = calcKdjSeries(bars, 9, 3, 3);
    for (const p of result) {
      expect(p.j).toBeCloseTo(3 * p.k - 2 * p.d, 10);
    }
  });
});
