/**
 * portfolio-sim.factor-registry.spec.ts
 *
 * 因子注册表纯函数单测：
 *   - VALID_RANK_FACTOR_KEYS 恰含 9 键 + 每条目结构合法。
 *   - momentum_60.compute（ATR 标准化，分母 0 / null 处置）。
 *   - resolveRankSpec 三分支（rankSpec 优先 / legacy none→[] / legacy 单因子）。
 */

import {
  RANK_FACTOR_REGISTRY,
  VALID_RANK_FACTOR_KEYS,
  resolveRankSpec,
  RankFactorRegistryEntry,
} from './portfolio-sim.factor-registry';
import {
  PortfolioSimSource,
  RankFactor,
  RankFactorKey,
} from './portfolio-sim.types';

/** 构造一个最小 source，仅覆盖排序相关字段（其余给占位值）。 */
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

describe('portfolio-sim factor registry', () => {
  // ───────────────────────────────────────────────
  // 注册表完整性
  // ───────────────────────────────────────────────
  describe('RANK_FACTOR_REGISTRY / VALID_RANK_FACTOR_KEYS', () => {
    const EXPECTED_KEYS: RankFactorKey[] = [
      'pos_120',
      'pos_60',
      'close_ma60_ratio',
      'vol_ratio_60',
      'vol_ratio_120',
      'risk_reward',
      'momentum_60',
      'circ_mv',
      'ml_score',
    ];

    it('VALID_RANK_FACTOR_KEYS 恰含 9 键', () => {
      expect(VALID_RANK_FACTOR_KEYS.size).toBe(9);
      for (const k of EXPECTED_KEYS) {
        expect(VALID_RANK_FACTOR_KEYS.has(k)).toBe(true);
      }
    });

    it('注册表 keys 与 EXPECTED_KEYS 集合一致', () => {
      expect(new Set(Object.keys(RANK_FACTOR_REGISTRY))).toEqual(
        new Set(EXPECTED_KEYS),
      );
    });

    it('每个条目 key 与其 Record 键一致', () => {
      for (const [k, entry] of Object.entries(RANK_FACTOR_REGISTRY)) {
        expect(entry.key).toBe(k);
      }
    });

    it('column 条目有合法 source（table+column 非空）、无 needs/compute', () => {
      const columns = Object.values(RANK_FACTOR_REGISTRY).filter(
        (e: RankFactorRegistryEntry) => e.kind === 'column',
      );
      expect(columns.length).toBe(8); // 9 因子中仅 momentum_60 是 computed
      for (const e of columns) {
        expect(e.source).toBeDefined();
        expect(typeof e.source!.table).toBe('string');
        expect(e.source!.table.length).toBeGreaterThan(0);
        expect(typeof e.source!.column).toBe('string');
        expect(e.source!.column.length).toBeGreaterThan(0);
        expect(e.needs).toBeUndefined();
        expect(e.compute).toBeUndefined();
      }
    });

    it('computed 条目（momentum_60）有 needs + compute、无 source', () => {
      const computed = Object.values(RANK_FACTOR_REGISTRY).filter(
        (e: RankFactorRegistryEntry) => e.kind === 'computed',
      );
      expect(computed.length).toBe(1);
      const e = computed[0];
      expect(e.key).toBe('momentum_60');
      expect(e.source).toBeUndefined();
      expect(Array.isArray(e.needs)).toBe(true);
      expect(e.needs!.length).toBe(3);
      for (const n of e.needs!) {
        expect(typeof n.table).toBe('string');
        expect(typeof n.column).toBe('string');
        expect(typeof n.alias).toBe('string');
        expect(n.alias.length).toBeGreaterThan(0);
      }
      expect(typeof e.compute).toBe('function');
    });

    it('ml_score histAvailable=false（前向专用），其余 8 因子 true', () => {
      for (const [k, e] of Object.entries(RANK_FACTOR_REGISTRY)) {
        expect(e.histAvailable).toBe(k !== 'ml_score');
      }
    });

    it('默认方向：risk_reward / momentum_60 / ml_score 为 desc，其余 asc', () => {
      const desc = new Set(['risk_reward', 'momentum_60', 'ml_score']);
      for (const [k, e] of Object.entries(RANK_FACTOR_REGISTRY)) {
        expect(e.defaultDir).toBe(desc.has(k) ? 'desc' : 'asc');
      }
    });
  });

  // ───────────────────────────────────────────────
  // momentum_60 现算（(close-ma60)/atr）
  // ───────────────────────────────────────────────
  describe('momentum_60.compute', () => {
    const compute = RANK_FACTOR_REGISTRY.momentum_60.compute!;

    it('正常：(close-ma60)/atr', () => {
      // (12 - 10) / 4 = 0.5
      expect(
        compute({ mom_close: 12, mom_ma60: 10, mom_atr: 4 }),
      ).toBeCloseTo(0.5, 12);
    });

    it('负动量：close < ma60 → 负值', () => {
      // (8 - 10) / 2 = -1
      expect(compute({ mom_close: 8, mom_ma60: 10, mom_atr: 2 })).toBeCloseTo(
        -1,
        12,
      );
    });

    it('atr=0 → null（不 ÷0）', () => {
      expect(compute({ mom_close: 12, mom_ma60: 10, mom_atr: 0 })).toBeNull();
    });

    it('atr=null → null', () => {
      expect(
        compute({ mom_close: 12, mom_ma60: 10, mom_atr: null }),
      ).toBeNull();
    });

    it('close=null → null', () => {
      expect(
        compute({ mom_close: null, mom_ma60: 10, mom_atr: 4 }),
      ).toBeNull();
    });

    it('ma60=null → null', () => {
      expect(
        compute({ mom_close: 12, mom_ma60: null, mom_atr: 4 }),
      ).toBeNull();
    });
  });

  // ───────────────────────────────────────────────
  // resolveRankSpec（三分支）
  // ───────────────────────────────────────────────
  describe('resolveRankSpec', () => {
    it('rankSpec.factors 非空 → 直接返回（优先于 legacy）', () => {
      const factors: RankFactor[] = [
        { factor: 'momentum_60', weight: 0.6, dir: 'desc' },
        { factor: 'pos_60', weight: 0.4, dir: 'asc' },
      ];
      const src = makeSource({
        rankField: 'pos_120', // legacy 字段存在但应被忽略
        rankDir: 'asc',
        rankSpec: { factors },
      });
      expect(resolveRankSpec(src)).toEqual(factors);
    });

    it('legacy rankField=none（无 rankSpec）→ []', () => {
      const src = makeSource({ rankField: 'none', rankDir: 'asc' });
      expect(resolveRankSpec(src)).toEqual([]);
    });

    it('legacy 单因子（无 rankSpec）→ 长度 1 且字段正确', () => {
      const src = makeSource({ rankField: 'circ_mv', rankDir: 'desc' });
      const out = resolveRankSpec(src);
      expect(out).toHaveLength(1);
      expect(out[0]).toEqual({ factor: 'circ_mv', weight: 1, dir: 'desc' });
    });

    it('rankSpec.factors 为空数组 → 落回 legacy 分支', () => {
      const src = makeSource({
        rankField: 'pos_120',
        rankDir: 'asc',
        rankSpec: { factors: [] },
      });
      // factors 空 → 不优先；rankField=pos_120 → 单因子
      expect(resolveRankSpec(src)).toEqual([
        { factor: 'pos_120', weight: 1, dir: 'asc' },
      ]);
    });
  });
});
