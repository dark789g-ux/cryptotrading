/**
 * portfolio-sim.ranking.spec.ts
 *
 * 引擎排序段单测（spec 03 / 09 测试计划）：
 *  - composite 综合分手算对拍
 *  - 平名次 / null 确定性（同值 / 同 null 候选 scoreByTrade 相等、两次运行一致）
 *  - 全因子 null 候选排末位、综合分最低
 *  - 质量分位 q（最优=1 / 最差=0 / n=1=1.0 / none=0.5）
 *  - 单因子退化 == 现 sortCandidates（逐位等价）
 *  - none 纯 ts_code 序、score 全 null
 */

import { rankAndScore } from './portfolio-sim.ranking';
import { sortCandidates } from './portfolio-sim.engine';
import {
  EngineTrade,
  PortfolioSimSource,
  RankFactorKey,
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

function trade(
  tsCode: string,
  factorValues?: Record<string, number | null>,
  overrides: Partial<EngineTrade> = {},
): EngineTrade {
  return {
    sourceIdx: 0,
    tsCode,
    signalDate: '20260101',
    buyDate: '20260102',
    exitDate: '20260103',
    ret: 0,
    holdDays: 1,
    rankValue: null,
    factorValues: factorValues as Record<RankFactorKey, number | null> | undefined,
    ...overrides,
  };
}

// ─────────────────────────────────────────────────────────────────────────────
// none：纯 ts_code 序、score 全 null、quality 全 0.5
// ─────────────────────────────────────────────────────────────────────────────
describe('rankAndScore · none', () => {
  it('factors 为空：按 ts_code 升序、scoreByTrade 全 null、qualityByTrade 全 0.5', () => {
    const src = source({ rankField: 'none' });
    const ts = [trade('C'), trade('A'), trade('B')];
    const { sorted, scoreByTrade, qualityByTrade } = rankAndScore(ts, src);
    expect(sorted.map((t) => t.tsCode)).toEqual(['A', 'B', 'C']);
    for (const t of ts) {
      expect(scoreByTrade.get(t)).toBeNull();
      expect(qualityByTrade.get(t)).toBe(0.5);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 单因子退化：逐位等价现 sortCandidates
// ─────────────────────────────────────────────────────────────────────────────
describe('rankAndScore · 单因子退化', () => {
  it('legacy 单因子（pos_120 desc）排序 == 现 sortCandidates（缺失置后、平局 ts_code）', () => {
    // legacy: rankField=pos_120/desc，rankValue 即因子值。
    // 为对拍 sortCandidates，需同时设 rankValue（旧路径）与 factorValues.pos_120（新路径）。
    const src = source({ rankField: 'pos_120', rankDir: 'desc' });
    const mk = (tsCode: string, v: number | null) =>
      trade(tsCode, { pos_120: v }, { rankValue: v });
    const ts = [
      mk('C', 5),
      mk('A', 10),
      mk('D', null),
      mk('B', 10), // 与 A 平局
      mk('E', null),
    ];
    const expected = sortCandidates(ts, src).map((t) => t.tsCode);
    const { sorted, scoreByTrade } = rankAndScore(ts, src);
    expect(sorted.map((t) => t.tsCode)).toEqual(expected);
    expect(sorted.map((t) => t.tsCode)).toEqual(['A', 'B', 'C', 'D', 'E']);
    // scoreByTrade = 因子值（null 保留 null）
    expect(scoreByTrade.get(ts[0])).toBe(5); // C
    expect(scoreByTrade.get(ts[2])).toBeNull(); // D
  });

  it('单因子 asc 与 sortCandidates asc 逐位一致', () => {
    const src = source({ rankField: 'circ_mv', rankDir: 'asc' });
    const mk = (tsCode: string, v: number | null) =>
      trade(tsCode, { circ_mv: v }, { rankValue: v });
    const ts = [mk('B', 30), mk('A', 10), mk('C', 20), mk('Z', null)];
    // sortCandidates 用 rankField='circ_mv'？sortCandidates 仅读 rankValue + useRank=rankField!=='none'。
    const legacySrc = source({ rankField: 'pos_120', rankDir: 'asc' }); // useRank=true 即可
    const expected = sortCandidates(ts, legacySrc).map((t) => t.tsCode);
    const { sorted } = rankAndScore(ts, src);
    expect(sorted.map((t) => t.tsCode)).toEqual(expected);
    expect(sorted.map((t) => t.tsCode)).toEqual(['A', 'C', 'B', 'Z']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// composite：综合分手算对拍
// ─────────────────────────────────────────────────────────────────────────────
describe('rankAndScore · composite 综合分手算', () => {
  function spec(factors: { factor: RankFactorKey; weight: number; dir: 'asc' | 'desc' }[]) {
    return source({ rankSpec: { factors } });
  }

  it('两因子等权手算：组首名次 × weight / totalWeight', () => {
    // n=3 候选 A/B/C。
    // f1 = pos_120 desc, weight 1：值 A=10,B=20,C=30 → desc 排 C,B,A → 名次分 C=3,B=2,A=1
    // f2 = circ_mv  asc,  weight 1：值 A=1, B=2, C=3  → asc  排 A,B,C → 名次分 A=3,B=2,C=1
    // rawScore: A=1+3=4, B=2+2=4, C=3+1=4 → 全 4 → 平局 ts_code 升序 A,B,C
    const src = spec([
      { factor: 'pos_120', weight: 1, dir: 'desc' },
      { factor: 'circ_mv', weight: 1, dir: 'asc' },
    ]);
    const ts = [
      trade('A', { pos_120: 10, circ_mv: 1 }),
      trade('B', { pos_120: 20, circ_mv: 2 }),
      trade('C', { pos_120: 30, circ_mv: 3 }),
    ];
    const { sorted, scoreByTrade } = rankAndScore(ts, src);
    expect(sorted.map((t) => t.tsCode)).toEqual(['A', 'B', 'C']); // 全同分 → ts_code
    // 综合分 = 4 / totalWeight(2) = 2
    for (const t of ts) expect(scoreByTrade.get(t)).toBeCloseTo(2, 10);
  });

  it('加权偏向：f1 权重大 → 主导排序', () => {
    // f1 = pos_120 desc, weight 3：C(30)→4*3=12, B(20)→3*3=9, A(10)→2*3=6  ... wait 用名次
    // n=3：f1 desc 排 C,B,A → 名次分 C=3,B=2,A=1，×3 → C=9,B=6,A=3
    // f2 = circ_mv asc, weight 1：A=1,B=2,C=3 → asc 排 A,B,C → A=3,B=2,C=1，×1
    // rawScore: A=3+3=6, B=6+2=8, C=9+1=10 → desc 10,8,6 → C,B,A
    const src = spec([
      { factor: 'pos_120', weight: 3, dir: 'desc' },
      { factor: 'circ_mv', weight: 1, dir: 'asc' },
    ]);
    const ts = [
      trade('A', { pos_120: 10, circ_mv: 1 }),
      trade('B', { pos_120: 20, circ_mv: 2 }),
      trade('C', { pos_120: 30, circ_mv: 3 }),
    ];
    const { sorted, scoreByTrade } = rankAndScore(ts, src);
    expect(sorted.map((t) => t.tsCode)).toEqual(['C', 'B', 'A']);
    expect(scoreByTrade.get(ts[2])).toBeCloseTo(10 / 4, 10); // C
    expect(scoreByTrade.get(ts[1])).toBeCloseTo(8 / 4, 10); // B
    expect(scoreByTrade.get(ts[0])).toBeCloseTo(6 / 4, 10); // A
  });

  it('composite totalWeight<=0：退化 ts_code 序、score 全 null（防御性守门）', () => {
    // 仅 composite（≥2 因子）才有 totalWeight 守门；单因子退化路径不读 weight。
    // 校验层保证 weight>0，此分支是防御性兜底。
    const src = spec([
      { factor: 'pos_120', weight: 0, dir: 'desc' },
      { factor: 'circ_mv', weight: 0, dir: 'asc' },
    ]);
    const ts = [
      trade('C', { pos_120: 30, circ_mv: 1 }),
      trade('A', { pos_120: 10, circ_mv: 9 }),
    ];
    const { sorted, scoreByTrade } = rankAndScore(ts, src);
    expect(sorted.map((t) => t.tsCode)).toEqual(['A', 'C']);
    for (const t of ts) expect(scoreByTrade.get(t)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 平名次 / null 确定性
// ─────────────────────────────────────────────────────────────────────────────
describe('rankAndScore · 平名次 / null 确定性', () => {
  it('composite 同值候选 scoreByTrade 相等（组首名次计分，不受输入顺序影响）', () => {
    // 两因子（composite 才走组首名次计分）。A、B 两因子都同值；C 不同。
    // f1 pos_120 desc w1：A=B=20（组首名次 0 → 分 3）、C=10（名次 2 → 分 1）。
    // f2 circ_mv  asc  w1：A=B=5 （组首名次 0 → 分 3）、C=9 （名次 2 → 分 1）。
    // rawScore: A=B=3+3=6, C=1+1=2 → 综合分 A=B=3, C=1。
    const src = source({
      rankSpec: {
        factors: [
          { factor: 'pos_120', weight: 1, dir: 'desc' },
          { factor: 'circ_mv', weight: 1, dir: 'asc' },
        ],
      },
    });
    const tsAB = [
      trade('A', { pos_120: 20, circ_mv: 5 }),
      trade('B', { pos_120: 20, circ_mv: 5 }),
      trade('C', { pos_120: 10, circ_mv: 9 }),
    ];
    const r1 = rankAndScore(tsAB, src);
    expect(r1.scoreByTrade.get(tsAB[0])).toBe(r1.scoreByTrade.get(tsAB[1])); // A==B 同分
    expect(r1.scoreByTrade.get(tsAB[0])).toBe(3);
    expect(r1.scoreByTrade.get(tsAB[2])).toBe(1); // C

    // 打乱输入顺序，结果一致（确定性）。
    const tsBA = [
      trade('C', { pos_120: 10, circ_mv: 9 }),
      trade('B', { pos_120: 20, circ_mv: 5 }),
      trade('A', { pos_120: 20, circ_mv: 5 }),
    ];
    const r2 = rankAndScore(tsBA, src);
    // 排序后 A,B 同分在前（ts_code 决定 A<B），C 殿后
    expect(r2.sorted.map((t) => t.tsCode)).toEqual(['A', 'B', 'C']);
    expect(r1.sorted.map((t) => t.tsCode)).toEqual(['A', 'B', 'C']);
  });

  it('composite 同 null 候选并列最低档、scoreByTrade 相等', () => {
    // 两因子。n=3：f1 上 A=10 有值、B/C null；f2 上全相等（不影响相对）。
    // f1 pos_120 desc w1：valued=[A] 名次 0 → A 分 3；nullScore=(n-valuedCount)=3-1=2 → B=C=2。
    // f2 circ_mv asc w1：A=B=C=7（全同值）→ 组首名次 0 → 全分 3。
    // rawScore: A=3+3=6, B=2+3=5, C=2+3=5 → 综合分 A=3, B=C=2.5。
    const src = source({
      rankSpec: {
        factors: [
          { factor: 'pos_120', weight: 1, dir: 'desc' },
          { factor: 'circ_mv', weight: 1, dir: 'asc' },
        ],
      },
    });
    const ts = [
      trade('A', { pos_120: 10, circ_mv: 7 }),
      trade('B', { pos_120: null, circ_mv: 7 }),
      trade('C', { pos_120: null, circ_mv: 7 }),
    ];
    const { sorted, scoreByTrade } = rankAndScore(ts, src);
    expect(sorted.map((t) => t.tsCode)).toEqual(['A', 'B', 'C']); // A 最优、B/C ts_code 二级
    expect(scoreByTrade.get(ts[0])).toBe(3); // A = 6/2
    expect(scoreByTrade.get(ts[1])).toBe(scoreByTrade.get(ts[2])); // B==C
    expect(scoreByTrade.get(ts[1])).toBe(2.5); // 5/2
  });

  it('全因子 null 候选排末位、综合分最低', () => {
    // 两因子。候选 Z 全 null；A/B 至少一因子有值。
    // f1 pos_120 desc weight1：A=30,B=20,Z=null → valued A,B 分 A=3(名次0),B=2(名次1)；Z null 分 (3-2)=1
    // f2 circ_mv asc weight1：A=null,B=10,Z=null → valued [B] 分 B=3；A,Z null 分 (3-1)=2
    // rawScore: A=3+2=5, B=2+3=5, Z=1+2=3 → Z 最低
    const src = source({
      rankSpec: {
        factors: [
          { factor: 'pos_120', weight: 1, dir: 'desc' },
          { factor: 'circ_mv', weight: 1, dir: 'asc' },
        ],
      },
    });
    const ts = [
      trade('A', { pos_120: 30, circ_mv: null }),
      trade('B', { pos_120: 20, circ_mv: 10 }),
      trade('Z', { pos_120: null, circ_mv: null }),
    ];
    const { sorted, scoreByTrade } = rankAndScore(ts, src);
    expect(sorted[sorted.length - 1].tsCode).toBe('Z'); // 末位
    expect(scoreByTrade.get(ts[2])).toBeCloseTo(3 / 2, 10); // Z 综合分最低
    expect(scoreByTrade.get(ts[2])!).toBeLessThan(scoreByTrade.get(ts[0])!);
    expect(scoreByTrade.get(ts[2])!).toBeLessThan(scoreByTrade.get(ts[1])!);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// 质量分位 q
// ─────────────────────────────────────────────────────────────────────────────
describe('rankAndScore · 质量分位 q', () => {
  it('最优=1、最差=0、中间线性（n=3）', () => {
    const src = source({
      rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'desc' }] },
    });
    const ts = [
      trade('A', { pos_120: 30 }),
      trade('B', { pos_120: 20 }),
      trade('C', { pos_120: 10 }),
    ];
    const { sorted, qualityByTrade } = rankAndScore(ts, src);
    // sorted: A(30),B(20),C(10)
    expect(qualityByTrade.get(sorted[0])).toBe(1); // 最优
    expect(qualityByTrade.get(sorted[1])).toBe(0.5); // 中间 (3-1-1)/(3-1)=0.5
    expect(qualityByTrade.get(sorted[2])).toBe(0); // 最差
  });

  it('n=1：q=1.0（约定满分）', () => {
    const src = source({
      rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'desc' }] },
    });
    const ts = [trade('A', { pos_120: 30 })];
    const { qualityByTrade } = rankAndScore(ts, src);
    expect(qualityByTrade.get(ts[0])).toBe(1.0);
  });

  it('none：q 全 0.5', () => {
    const src = source({ rankField: 'none' });
    const ts = [trade('A'), trade('B')];
    const { qualityByTrade } = rankAndScore(ts, src);
    expect(qualityByTrade.get(ts[0])).toBe(0.5);
    expect(qualityByTrade.get(ts[1])).toBe(0.5);
  });

  it('null 殿后候选 q 趋近 0', () => {
    const src = source({
      rankSpec: { factors: [{ factor: 'pos_120', weight: 1, dir: 'desc' }] },
    });
    const ts = [
      trade('A', { pos_120: 30 }),
      trade('B', { pos_120: null }),
    ];
    const { sorted, qualityByTrade } = rankAndScore(ts, src);
    expect(sorted.map((t) => t.tsCode)).toEqual(['A', 'B']);
    expect(qualityByTrade.get(sorted[0])).toBe(1); // 有值最优
    expect(qualityByTrade.get(sorted[1])).toBe(0); // null 殿后
  });
});
