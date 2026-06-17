import { calcIndicators, KlineRow } from '../indicators/indicators';
import {
  DEFAULT_KDJ_PARAMS,
  KDJ_FIELD_KEYS,
  KdjBar,
  isCustomKdjParams,
  isKdjField,
  lastTwoKdj,
} from './kdj-params';

/**
 * 固定 OHLC 序列（写死，确定性）。70 根，带上下波动，保证 KDJ 充分收敛且
 * RSV 在高低区间都取到（避免恒为 50 的退化）。
 *
 * 用确定性公式生成后展开为字面量数组，序列本身写死、无随机、无依赖。
 */
function buildFixedBars(): KdjBar[] {
  const bars: KdjBar[] = [];
  let base = 100;
  for (let i = 0; i < 70; i++) {
    // 确定性的上下摆动（正弦叠加缓慢漂移），制造涨跌交替。
    const drift = Math.sin(i / 5) * 8 + Math.cos(i / 3) * 4 + (i % 7) - 3;
    const close = base + drift;
    const high = close + 2 + (i % 3);
    const low = close - 2 - (i % 4);
    bars.push({
      high: Number(high.toFixed(4)),
      low: Number(low.toFixed(4)),
      close: Number(close.toFixed(4)),
    });
    base += Math.sin(i / 11) * 1.5; // 缓慢趋势
  }
  return bars;
}

const FIXED_BARS = buildFixedBars();

/** 把 KdjBar 序列转成 calcIndicators 所需的 KlineRow（仅 KDJ 用到 high/low/close）。 */
function toKlineRows(bars: KdjBar[]): KlineRow[] {
  return bars.map((b, i) => ({
    open_time: `bar_${i}`,
    open: b.close,
    high: b.high,
    low: b.low,
    close: b.close,
    volume: 0,
  }));
}

describe('kdj-params 纯逻辑', () => {
  describe('isKdjField', () => {
    it.each(KDJ_FIELD_KEYS)('识别 KDJ 字段 %s 为 true', (key) => {
      expect(isKdjField(key)).toBe(true);
    });

    it.each(['close', 'ma5', 'macd', 'kdj', 'KDJ_J', ''])(
      '非 KDJ 字段 %s 为 false',
      (key) => {
        expect(isKdjField(key)).toBe(false);
      },
    );
  });

  describe('isCustomKdjParams', () => {
    it('缺省（undefined）返回 false', () => {
      expect(isCustomKdjParams(undefined)).toBe(false);
    });

    it('全等 9/3/3 返回 false', () => {
      expect(isCustomKdjParams({ ...DEFAULT_KDJ_PARAMS })).toBe(false);
    });

    it.each([
      ['n 不同', { n: 6, m1: 3, m2: 3 }],
      ['m1 不同', { n: 9, m1: 2, m2: 3 }],
      ['m2 不同', { n: 9, m1: 3, m2: 2 }],
      ['全不同 6/2/2', { n: 6, m1: 2, m2: 2 }],
    ] as const)('%s 返回 true', (_label, p) => {
      expect(isCustomKdjParams(p)).toBe(true);
    });
  });

  describe('lastTwoKdj', () => {
    it('对拍 calcIndicators(9/3/3)：curr 与最后一根 KDJ.J/K/D 吻合', () => {
      const rows = toKlineRows(FIXED_BARS);
      const withInd = calcIndicators(rows);
      const last = withInd[withInd.length - 1];

      const { curr, prev } = lastTwoKdj(FIXED_BARS, 9, 3, 3);

      expect(curr.j).toBeCloseTo(last['KDJ.J'], 3);
      expect(curr.k).toBeCloseTo(last['KDJ.K'], 3);
      expect(curr.d).toBeCloseTo(last['KDJ.D'], 3);

      // prev 对拍倒数第二根
      const secondLast = withInd[withInd.length - 2];
      expect(prev).not.toBeNull();
      expect(prev!.j).toBeCloseTo(secondLast['KDJ.J'], 3);
      expect(prev!.k).toBeCloseTo(secondLast['KDJ.K'], 3);
      expect(prev!.d).toBeCloseTo(secondLast['KDJ.D'], 3);
    });

    it('6/2/2 锁值（回归护门）', () => {
      const { curr } = lastTwoKdj(FIXED_BARS, 6, 2, 2);
      // 期望值由 precomputeAllKdj 在 FIXED_BARS 上实测固化（锁口径，防回归漂移）
      expect(curr.k).toBeCloseTo(76.47295624220921, 4);
      expect(curr.d).toBeCloseTo(68.14533921188182, 4);
      expect(curr.j).toBeCloseTo(93.128190302864, 4);
    });

    it('单根序列 prev 为 null', () => {
      const { curr, prev } = lastTwoKdj([FIXED_BARS[0]], 9, 3, 3);
      expect(prev).toBeNull();
      // 首根 RSV 据 close 在 [low,high] 的位置，k/d 由 50 种子推一步
      expect(typeof curr.j).toBe('number');
      expect(Number.isFinite(curr.j)).toBe(true);
    });

    it('空序列抛错', () => {
      expect(() => lastTwoKdj([], 9, 3, 3)).toThrow();
    });
  });
});
