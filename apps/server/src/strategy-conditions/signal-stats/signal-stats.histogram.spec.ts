/**
 * signal-stats.histogram.spec.ts
 *
 * 纯函数 buildRetHistogram 单测。
 * 覆盖：空数组、全相等、全胜、全亏、正负混合、计数守恒、空档补齐、浮点边界。
 */
import { buildRetHistogram, RetHistogramBin } from './signal-stats.histogram';

// ── 辅助 ──────────────────────────────────────────────────────────────────────

/** 校验 bins 区间连续（相邻档 hi===lo+1 即 (b+1)*w===(b+2)*w 即 next.lo===this.hi） */
function assertContinuous(bins: RetHistogramBin[]) {
  for (let i = 0; i < bins.length - 1; i++) {
    // 允许浮点误差 1e-10
    expect(Math.abs(bins[i + 1].lo - bins[i].hi)).toBeLessThan(1e-10);
  }
}

// ── 空数组 ────────────────────────────────────────────────────────────────────

describe('buildRetHistogram - empty input', () => {
  it('returns empty bins, null binWidth, sampleCount=0', () => {
    const result = buildRetHistogram('run-1', [], 25);
    expect(result).toEqual({
      runId: 'run-1',
      sampleCount: 0,
      binWidth: null,
      bins: [],
    });
  });
});

// ── 全相等（range=0 兜底）────────────────────────────────────────────────────

describe('buildRetHistogram - all equal (range=0)', () => {
  it('uses fallback binWidth=0.01 and does not crash', () => {
    const result = buildRetHistogram('run-2', [0.05, 0.05, 0.05], 25);
    expect(result.binWidth).toBe(0.01);
    expect(result.sampleCount).toBe(3);
    expect(result.bins.length).toBeGreaterThan(0);
  });

  it('sampleCount === rets.length', () => {
    const result = buildRetHistogram('run-2', [0.05, 0.05, 0.05], 25);
    expect(result.sampleCount).toBe(3);
  });

  it('all bins sign=win (positive equal value)', () => {
    const result = buildRetHistogram('run-2', [0.05, 0.05, 0.05], 25);
    for (const bin of result.bins) {
      expect(bin.sign).toBe('win');
    }
  });

  it('all bins sign=loss (negative equal value)', () => {
    const result = buildRetHistogram('run-3', [-0.05, -0.05, -0.05], 25);
    for (const bin of result.bins) {
      expect(bin.sign).toBe('loss');
    }
  });
});

// ── 全胜（全正）──────────────────────────────────────────────────────────────

describe('buildRetHistogram - all wins', () => {
  const rets = [0.01, 0.02, 0.03, 0.05, 0.08];

  it('all bins have sign=win', () => {
    const result = buildRetHistogram('run-4', rets, 25);
    for (const bin of result.bins) {
      expect(bin.sign).toBe('win');
    }
  });

  it('count conservation', () => {
    const result = buildRetHistogram('run-4', rets, 25);
    expect(result.sampleCount).toBe(rets.length);
    const total = result.bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(rets.length);
  });
});

// ── 全亏（全负）──────────────────────────────────────────────────────────────

describe('buildRetHistogram - all losses', () => {
  const rets = [-0.08, -0.05, -0.03, -0.02, -0.01];

  it('all bins have sign=loss', () => {
    const result = buildRetHistogram('run-5', rets, 25);
    for (const bin of result.bins) {
      expect(bin.sign).toBe('loss');
    }
  });

  it('count conservation', () => {
    const result = buildRetHistogram('run-5', rets, 25);
    expect(result.sampleCount).toBe(rets.length);
    const total = result.bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(rets.length);
  });
});

// ── 正负混合（含 0 边界） ──────────────────────────────────────────────────

describe('buildRetHistogram - mixed wins and losses', () => {
  // 有负有正，跨 0
  const rets = [-0.06, -0.03, 0.0, 0.03, 0.06];

  it('count conservation', () => {
    const result = buildRetHistogram('run-6', rets, 10);
    expect(result.sampleCount).toBe(rets.length);
    const total = result.bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(rets.length);
  });

  it('no bin spans both win and loss (lo<0 && hi>0)', () => {
    const result = buildRetHistogram('run-6', rets, 10);
    for (const bin of result.bins) {
      // 单档不能同时跨负和正（0 恰在 bucket 0 的精确下边界）
      expect(bin.lo < 0 && bin.hi > 0).toBe(false);
    }
  });

  it('bin with lo===0 has sign=win', () => {
    const result = buildRetHistogram('run-6', rets, 10);
    const zeroBin = result.bins.find((b) => Math.abs(b.lo) < 1e-12);
    if (zeroBin) {
      expect(zeroBin.sign).toBe('win');
    }
  });

  it('bins are continuous (no gaps)', () => {
    const result = buildRetHistogram('run-6', rets, 10);
    assertContinuous(result.bins);
  });
});

// ── 空档补齐 ──────────────────────────────────────────────────────────────────

describe('buildRetHistogram - gap filling', () => {
  // rets 只有 0.01 和 0.09，中间有 gap
  const rets = [0.01, 0.09];

  it('bins are continuous (empty buckets filled with count=0)', () => {
    const result = buildRetHistogram('run-7', rets, 25);
    expect(result.bins.length).toBeGreaterThan(2);
    assertContinuous(result.bins);
  });

  it('empty middle bins have count=0', () => {
    const result = buildRetHistogram('run-7', rets, 25);
    // 至少一个中间档 count=0
    const emptied = result.bins.filter((b) => b.count === 0);
    expect(emptied.length).toBeGreaterThan(0);
  });

  it('count conservation even with gap filling', () => {
    const result = buildRetHistogram('run-7', rets, 25);
    expect(result.sampleCount).toBe(rets.length);
    const total = result.bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(rets.length);
  });
});

// ── 浮点边界（经典 0.06/0.02 坑） ─────────────────────────────────────────

describe('buildRetHistogram - floating point boundary', () => {
  it('ret=0.06 with binWidth=0.02 does not fall into wrong bucket', () => {
    // 0.06 / 0.02 在 IEEE754 里可能是 2.9999...，不加 epsilon 会错归 bucket 2 而非 3
    // 此测试：rets=[0.02, 0.04, 0.06]，range=0.04，bins=2（clamp→5），niceStep → 0.01
    // 关键是确保 0.06 与 0.04 不在同一个 bucket（自然分档，不强制 binWidth=0.02）
    // 但我们可以直接用大量点锁定 binWidth=0.02 的场景
    // rets 精心构造：lo=0.00, hi=0.08, range=0.08, clampedBins=5, raw=0.016 → niceStep=0.02
    const testRets = [0.0, 0.02, 0.04, 0.06, 0.08];
    const result = buildRetHistogram('run-8', testRets, 5);
    expect(result.binWidth).toBe(0.02);

    // 每个 ret 应在独立的 bucket
    const countsAbove0 = result.bins.filter((b) => b.count > 0);
    // 5 个点，5 个档，每档 count=1
    expect(countsAbove0.length).toBe(5);
    for (const bin of countsAbove0) {
      expect(bin.count).toBe(1);
    }
  });

  it('count conservation on floating-point boundary case', () => {
    const testRets = [0.0, 0.02, 0.04, 0.06, 0.08];
    const result = buildRetHistogram('run-8', testRets, 5);
    expect(result.sampleCount).toBe(testRets.length);
    const total = result.bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(testRets.length);
  });
});

// ── sampleCount 守恒（综合） ──────────────────────────────────────────────

describe('buildRetHistogram - sampleCount invariant', () => {
  it('sampleCount === Σcount === rets.length for random-like array', () => {
    const rets = [-0.12, -0.08, -0.05, -0.02, 0.0, 0.01, 0.03, 0.07, 0.11, 0.15];
    const result = buildRetHistogram('run-9', rets, 25);
    expect(result.sampleCount).toBe(rets.length);
    const total = result.bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(rets.length);
  });
});

// ── 大样本不栈溢出（min/max spread 回归） ──────────────────────────────────

describe('buildRetHistogram - 大样本 N=500000 不栈溢出', () => {
  // 旧实现 Math.min(...rets)/Math.max(...rets) 大样本下超 V8 实参上限抛
  // RangeError: Maximum call stack size exceeded（同 signal-stats.metrics）。
  const N = 500_000;
  const rets = new Array<number>(N);
  for (let i = 0; i < N; i++) {
    rets[i] = ((i % 1000) - 500) * 0.0001; // 值域约 [-0.05, 0.0499]
  }
  rets[123] = -0.9; // 植入确定最小
  rets[456] = 1.5; // 植入确定最大

  it('不抛 RangeError', () => {
    expect(() => buildRetHistogram('run-big', rets, 25)).not.toThrow();
  });

  it('count 守恒 & sampleCount=N', () => {
    const result = buildRetHistogram('run-big', rets, 25);
    expect(result.sampleCount).toBe(N);
    const total = result.bins.reduce((s, b) => s + b.count, 0);
    expect(total).toBe(N);
  });
});
