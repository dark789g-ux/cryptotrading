/**
 * portfolio-sim.sizing.spec.ts
 *
 * 引擎仓位段单测（spec 04 / 09 测试计划）：
 *  - fixed 零漂移（== positionRatio × navRef）
 *  - signal_weighted q=0/0.5/1 + none→mult=1
 *  - source_kelly：mult=clamp(kf·frac,0,max)、全胜源(avgLoss=null)→1、全亏源(avgWin=null)→0、负期望→0
 *  - anchorMode 任意 mode 恒等 fixed
 *  - weightEntry == alloc/navRef（在 engine 集成中验，本文件验 alloc 计算）
 */

import {
  computeAlloc,
  computeSourceKellyMult,
  MIN_ALLOC_YUAN,
} from './portfolio-sim.sizing';
import {
  EngineTrade,
  PortfolioSimSource,
  SizingConfig,
} from './portfolio-sim.types';

function source(overrides: Partial<PortfolioSimSource> = {}): PortfolioSimSource {
  return {
    runId: 'run-a',
    label: 'A',
    positionRatio: 0.1,
    maxPositions: null,
    exposureCap: null,
    rankField: 'none',
    rankDir: 'asc',
    ...overrides,
  };
}

function trade(tsCode = 'X'): EngineTrade {
  return {
    sourceIdx: 0,
    tsCode,
    signalDate: '20260101',
    buyDate: '20260102',
    exitDate: '20260103',
    ret: 0,
    holdDays: 1,
    rankValue: null,
  };
}

const sizing = (overrides: Partial<SizingConfig>): SizingConfig => ({
  mode: 'fixed',
  floorMult: 0.5,
  capMult: 1.5,
  kellyFraction: 0.5,
  kellyMaxMult: 1.0,
  ...overrides,
});

const NAV = 1_000_000;

// ─────────────────────────────────────────────────────────────────────────────
// fixed（默认，零漂移）
// ─────────────────────────────────────────────────────────────────────────────
describe('computeAlloc · fixed', () => {
  it('未配置 sizing → mult=1 == positionRatio × navRef（零漂移）', () => {
    const src = source({ positionRatio: 0.3 });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map(),
    });
    expect(alloc).toBeCloseTo(0.3 * NAV, 6);
  });

  it('显式 sizing.mode=fixed → mult=1', () => {
    const src = source({ positionRatio: 0.2, sizing: sizing({ mode: 'fixed' }) });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map(),
    });
    expect(alloc).toBeCloseTo(0.2 * NAV, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// signal_weighted
// ─────────────────────────────────────────────────────────────────────────────
describe('computeAlloc · signal_weighted', () => {
  function allocWithQ(q: number): number {
    const src = source({
      positionRatio: 0.1,
      rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'desc' }] },
      sizing: sizing({ mode: 'signal_weighted', floorMult: 0.5, capMult: 1.5 }),
    });
    const t = trade();
    const qMap = new Map<EngineTrade, number>([[t, q]]);
    return computeAlloc(t, src, NAV, {
      anchorMode: false,
      qualityByTrade: qMap,
    });
  }

  it('q=0 → floorMult', () => {
    expect(allocWithQ(0)).toBeCloseTo(0.1 * 0.5 * NAV, 6);
  });
  it('q=1 → capMult', () => {
    expect(allocWithQ(1)).toBeCloseTo(0.1 * 1.5 * NAV, 6);
  });
  it('q=0.5 → 中点 mult=1.0', () => {
    expect(allocWithQ(0.5)).toBeCloseTo(0.1 * 1.0 * NAV, 6);
  });

  it('qualityByTrade 缺该 trade → 默认 q=0.5（中点）', () => {
    const src = source({
      positionRatio: 0.1,
      rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'desc' }] },
      sizing: sizing({ mode: 'signal_weighted' }),
    });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map(), // 不含该 trade
    });
    expect(alloc).toBeCloseTo(0.1 * 1.0 * NAV, 6); // floor 0.5 + (1.5-0.5)*0.5 = 1.0
  });

  it('none 排序 → 强制 mult=1（不走 (floor+cap)/2）', () => {
    const src = source({
      positionRatio: 0.1,
      rankField: 'none', // resolveRankSpec → []
      sizing: sizing({ mode: 'signal_weighted', floorMult: 0.5, capMult: 1.5 }),
    });
    const t = trade();
    const qMap = new Map<EngineTrade, number>([[t, 0.5]]);
    const alloc = computeAlloc(t, src, NAV, {
      anchorMode: false,
      qualityByTrade: qMap,
    });
    // none → mult=1（非 (0.5+1.5)/2 也=1，但此处 floor/cap 非对称仍须=1）
    expect(alloc).toBeCloseTo(0.1 * 1.0 * NAV, 6);
  });

  it('none + 非对称 floor/cap → 仍 mult=1（不被放缩）', () => {
    const src = source({
      positionRatio: 0.1,
      rankField: 'none',
      sizing: sizing({ mode: 'signal_weighted', floorMult: 0.2, capMult: 2.0 }),
    });
    const t = trade();
    const alloc = computeAlloc(t, src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map([[t, 0.5]]),
    });
    expect(alloc).toBeCloseTo(0.1 * 1.0 * NAV, 6); // 若误走 (0.2+2.0)/2=1.1 则会失败
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// source_kelly
// ─────────────────────────────────────────────────────────────────────────────
describe('computeAlloc · source_kelly', () => {
  it('ctx.sourceKellyMult 透传为 mult', () => {
    const src = source({
      positionRatio: 0.1,
      sizing: sizing({ mode: 'source_kelly' }),
    });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map(),
      sourceKellyMult: 0.8,
    });
    expect(alloc).toBeCloseTo(0.1 * 0.8 * NAV, 6);
  });

  it('sourceKellyMult 缺省 → mult=1', () => {
    const src = source({
      positionRatio: 0.1,
      sizing: sizing({ mode: 'source_kelly' }),
    });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map(),
    });
    expect(alloc).toBeCloseTo(0.1 * 1.0 * NAV, 6);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// computeSourceKellyMult（源级凯利预算 + 分流）
// ─────────────────────────────────────────────────────────────────────────────
describe('computeSourceKellyMult', () => {
  const cfg = { kellyFraction: 0.5, kellyMaxMult: 1.0 };

  it('正期望源 → clamp(kf·frac, 0, max)', () => {
    // p=0.6, b=2：avgWin/|avgLoss|=2。kf = 0.6 - 0.4/2 = 0.4。
    // 构造 6 笔盈（+0.2）、4 笔亏（-0.1）→ avgWin=0.2, avgLoss=-0.1, b=2, p=0.6, kf=0.4。
    const rets = [
      ...Array(6).fill(0.2),
      ...Array(4).fill(-0.1),
    ];
    const mult = computeSourceKellyMult(rets, cfg);
    // kf=0.4, frac=0.5 → 0.2, clamp[0,1] → 0.2
    expect(mult).toBeCloseTo(0.2, 6);
  });

  it('kellyMaxMult 上限 clamp', () => {
    // 高凯利 → kf·frac 可能 > max=1。构造 p 高、b 大。
    // 9 盈(+1.0)、1 亏(-0.01)：avgWin=1, avgLoss=-0.01, b=100, p=0.9, kf=0.9-0.1/100≈0.899
    const rets = [...Array(9).fill(1.0), -0.01];
    const mult = computeSourceKellyMult(rets, { kellyFraction: 5, kellyMaxMult: 1.0 });
    expect(mult).toBe(1.0); // 被 max clamp
  });

  it('负期望源（kellyF<0）→ mult=0', () => {
    // p=0.3, b=1：kf = 0.3 - 0.7/1 = -0.4 < 0 → 0。
    // 3 盈(+0.1)、7 亏(-0.1/...)使 avgWin/|avgLoss|=1。盈 +0.1×3，亏 -0.1×7 → avgWin=0.1,avgLoss=-0.1,b=1,p=0.3
    const rets = [...Array(3).fill(0.1), ...Array(7).fill(-0.1)];
    const mult = computeSourceKellyMult(rets, cfg);
    expect(mult).toBe(0);
  });

  it('全胜源（avgLoss=null，无亏损样本）→ mult=1（中性，不惩罚）', () => {
    const rets = [0.1, 0.2, 0.3]; // 全正 → lossRets 空 → avgLoss=null → kellyF=null
    let warned = false;
    const mult = computeSourceKellyMult(rets, cfg, () => {
      warned = true;
    });
    expect(mult).toBe(1);
    expect(warned).toBe(true); // 退化 fixed 须 warn
  });

  it('全亏源（avgWin=null，无盈利样本）→ mult=0（最差，sized_out）', () => {
    const rets = [-0.1, -0.2, -0.3]; // 全负 → winRets 空 → avgWin=null, avgLoss!=null
    let warned = false;
    const mult = computeSourceKellyMult(rets, cfg, () => {
      warned = true;
    });
    expect(mult).toBe(0);
    expect(warned).toBe(false); // 全亏是确定性 0，不 warn
  });

  it('全平源（全 ret=0，无盈无亏）→ mult=1（无法定凯利，不惩罚）', () => {
    const rets = [0, 0, 0]; // 既不计 win 也不计 loss → avgWin=null && avgLoss=null
    let warned = false;
    const mult = computeSourceKellyMult(rets, cfg, () => {
      warned = true;
    });
    expect(mult).toBe(1);
    expect(warned).toBe(true);
  });

  it('空样本 → mult=1（样本不足，不惩罚）', () => {
    let warned = false;
    const mult = computeSourceKellyMult([], cfg, () => {
      warned = true;
    });
    expect(mult).toBe(1);
    expect(warned).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// anchorMode 恒等 fixed
// ─────────────────────────────────────────────────────────────────────────────
describe('computeAlloc · anchorMode 恒等', () => {
  it('anchorMode 下任意 mode 都 == positionRatio × navRef', () => {
    const t = trade();
    const qMap = new Map<EngineTrade, number>([[t, 1]]); // 即便 q=1
    const modes: SizingConfig['mode'][] = ['fixed', 'signal_weighted', 'source_kelly'];
    for (const mode of modes) {
      const src = source({
        positionRatio: 0.1,
        rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'desc' }] },
        sizing: sizing({ mode, floorMult: 0.5, capMult: 1.5 }),
      });
      const alloc = computeAlloc(t, src, NAV, {
        anchorMode: true,
        qualityByTrade: qMap,
        sourceKellyMult: 0.3, // 应被忽略
      });
      expect(alloc).toBeCloseTo(0.1 * NAV, 6);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// sized_out 边界
// ─────────────────────────────────────────────────────────────────────────────
describe('computeAlloc · sized_out 边界', () => {
  it('source_kelly mult=0 → alloc=0 < MIN_ALLOC_YUAN', () => {
    const src = source({
      positionRatio: 0.1,
      sizing: sizing({ mode: 'source_kelly' }),
    });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map(),
      sourceKellyMult: 0,
    });
    expect(alloc).toBe(0);
    expect(alloc).toBeLessThan(MIN_ALLOC_YUAN);
  });

  it('signal_weighted floor>0 → mult≥floor>0 → 永不 alloc<MIN', () => {
    const src = source({
      positionRatio: 0.1,
      rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'desc' }] },
      sizing: sizing({ mode: 'signal_weighted', floorMult: 0.5 }),
    });
    const t = trade();
    const alloc = computeAlloc(t, src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map([[t, 0]]), // 最差 q=0 → floor
    });
    expect(alloc).toBeGreaterThanOrEqual(MIN_ALLOC_YUAN);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// effectivePositionRatio（M1 regime 覆盖 base 比例）
// ─────────────────────────────────────────────────────────────────────────────
describe('computeAlloc · effectivePositionRatio（regime 覆盖 base）', () => {
  it('给 effectivePositionRatio → 覆盖 source.positionRatio 作 base', () => {
    const src = source({ positionRatio: 0.1 });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map(),
      effectivePositionRatio: 0.45,
    });
    expect(alloc).toBeCloseTo(0.45 * NAV, 6); // 用 0.45 不是 0.1
  });

  it('缺省 effectivePositionRatio → 回落 source.positionRatio（零漂移）', () => {
    const src = source({ positionRatio: 0.1 });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map(),
      // effectivePositionRatio 缺省
    });
    expect(alloc).toBeCloseTo(0.1 * NAV, 6);
  });

  it('与 sizing mult 共乘：base=effective × mult', () => {
    const src = source({
      positionRatio: 0.1,
      rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'desc' }] },
      sizing: sizing({ mode: 'signal_weighted', floorMult: 0.5, capMult: 1.5 }),
    });
    const t = trade();
    const alloc = computeAlloc(t, src, NAV, {
      anchorMode: false,
      qualityByTrade: new Map([[t, 1]]), // q=1 → mult=1.5
      effectivePositionRatio: 0.2,
    });
    // base=0.2（regime 覆盖）× 1.5（sizing）× NAV
    expect(alloc).toBeCloseTo(0.2 * 1.5 * NAV, 6);
  });

  it('anchorMode 短路忽略 effectivePositionRatio（仍用 source.positionRatio）', () => {
    const src = source({ positionRatio: 0.1 });
    const alloc = computeAlloc(trade(), src, NAV, {
      anchorMode: true,
      qualityByTrade: new Map(),
      effectivePositionRatio: 0.45, // 应被忽略
    });
    expect(alloc).toBeCloseTo(0.1 * NAV, 6); // 用 source 0.1，不是 regime 0.45
  });
});
