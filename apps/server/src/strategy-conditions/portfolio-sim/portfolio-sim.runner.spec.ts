/**
 * portfolio-sim.runner.spec.ts
 *
 * runner 纯逻辑单测：deriveRankField（落库 rank_field 口径派生，经 resolveRankSpec）。
 *   - composite：factors >1 → 'composite'
 *   - 单因子：factors ===1 → factors[0].factor（rankSpec 与 legacy 两路径）
 *   - none：factors ===0 → 'none'
 *   - rankSpec 优先于 legacy rankField
 */

import { deriveRankField } from './portfolio-sim.runner';
import { PortfolioSimSource, RankFactor } from './portfolio-sim.types';

/** 最小 source，仅覆盖排序相关字段。 */
function makeSource(
  overrides: Partial<PortfolioSimSource>,
): PortfolioSimSource {
  return {
    runId: 'run-1',
    label: 'S1',
    positionRatio: 0.1,
    maxPositions: null,
    exposureCap: null,
    rankField: 'pos_120',
    rankDir: 'asc',
    ...overrides,
  };
}

describe('portfolio-sim runner · deriveRankField', () => {
  it('多因子 rankSpec（>1）→ composite', () => {
    const factors: RankFactor[] = [
      { factor: 'momentum_60', weight: 0.6, dir: 'desc' },
      { factor: 'pos_60', weight: 0.4, dir: 'asc' },
    ];
    const src = makeSource({ rankSpec: { factors } });
    expect(deriveRankField(src)).toBe('composite');
  });

  it('单因子 rankSpec（===1）→ 该因子 KEY', () => {
    const src = makeSource({
      rankSpec: { factors: [{ factor: 'risk_reward', weight: 1, dir: 'desc' }] },
    });
    expect(deriveRankField(src)).toBe('risk_reward');
  });

  it('legacy 单因子（rankField=circ_mv，无 rankSpec）→ circ_mv', () => {
    const src = makeSource({ rankField: 'circ_mv', rankDir: 'desc' });
    expect(deriveRankField(src)).toBe('circ_mv');
  });

  it('legacy rankField=none（无 rankSpec）→ none', () => {
    const src = makeSource({ rankField: 'none', rankDir: 'asc' });
    expect(deriveRankField(src)).toBe('none');
  });

  it('rankSpec.factors 空数组 → 落回 legacy（pos_120）', () => {
    const src = makeSource({
      rankField: 'pos_120',
      rankDir: 'asc',
      rankSpec: { factors: [] },
    });
    expect(deriveRankField(src)).toBe('pos_120');
  });

  it('rankSpec 优先于 legacy rankField：legacy=pos_120 但 spec=单因子 ml_score → ml_score', () => {
    const src = makeSource({
      rankField: 'pos_120',
      rankDir: 'asc',
      rankSpec: { factors: [{ factor: 'ml_score', weight: 1, dir: 'desc' }] },
    });
    expect(deriveRankField(src)).toBe('ml_score');
  });
});
