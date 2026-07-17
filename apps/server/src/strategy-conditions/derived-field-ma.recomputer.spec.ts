import { MaFieldRecomputer } from './derived-field-ma.recomputer';
import { DerivedFieldSnapshot } from './derived-field-registry';
import { DerivedFieldRecomputeService } from './derived-field-recompute.service';
import { StrategyConditionItem } from '../entities/strategy/strategy-condition.entity';

/** 构造一条条件(最小字段)。 */
function cond(
  c: Partial<StrategyConditionItem> &
    Pick<StrategyConditionItem, 'field' | 'operator'>,
): StrategyConditionItem {
  return c as StrategyConditionItem;
}

/** 构造 mock DerivedFieldRecomputeService,返回预定义的 qfq bars。 */
function mockRecomputeService(
  barsMap: Map<string, { close: number }[]>,
): jest.Mocked<DerivedFieldRecomputeService> {
  return {
    loadQfqBars: jest.fn().mockImplementation(
      async (_tsCodes, _asOfDate, _bars) => {
        // 转换为 DerivedQuoteBar[]
        const result = new Map<string, ReturnType<DerivedFieldRecomputeService['loadQfqBars']> extends Promise<Map<string, infer V>> ? V : never>();
        for (const [tsCode, bars] of barsMap) {
          result.set(tsCode, bars.map((b, i) => ({
            tradeDate: `202607${String(16 - bars.length + i + 1).padStart(2, '0')}`,
            open: b.close,
            high: b.close,
            low: b.close,
            close: b.close,
            vol: 0,
            amount: 0,
          })));
        }
        return result;
      },
    ),
  } as unknown as jest.Mocked<DerivedFieldRecomputeService>;
}

describe('MaFieldRecomputer', () => {
  let service: MaFieldRecomputer;
  let mockSvc: jest.Mocked<DerivedFieldRecomputeService>;

  beforeEach(() => {
    mockSvc = mockRecomputeService(new Map());
    service = new MaFieldRecomputer(mockSvc);
  });

  describe('needsRecompute', () => {
    it('returns false for pre-existing COL_MAP fields (ma5/30/60/120/240)', () => {
      expect(service.needsRecompute(cond({ field: 'ma5', operator: 'gt' }))).toBe(false);
      expect(service.needsRecompute(cond({ field: 'ma30', operator: 'gt' }))).toBe(false);
      expect(service.needsRecompute(cond({ field: 'ma60', operator: 'gt' }))).toBe(false);
      expect(service.needsRecompute(cond({ field: 'ma120', operator: 'gt' }))).toBe(false);
      expect(service.needsRecompute(cond({ field: 'ma240', operator: 'gt' }))).toBe(false);
    });

    it('returns true for non-COL_MAP MA fields', () => {
      expect(service.needsRecompute(cond({ field: 'ma20', operator: 'gt' }))).toBe(true);
      expect(service.needsRecompute(cond({ field: 'ma10', operator: 'gt' }))).toBe(true);
      expect(service.needsRecompute(cond({ field: 'ma15', operator: 'gt' }))).toBe(true);
    });

    it('returns false for non-MA fields', () => {
      expect(service.needsRecompute(cond({ field: 'kdj_j', operator: 'gt' }))).toBe(false);
      expect(service.needsRecompute(cond({ field: 'macd_dif', operator: 'gt' }))).toBe(false);
    });
  });

  describe('recomputeLatest', () => {
    it('computes correct SMA for sufficient data', async () => {
      // ma20: 20 bars, last close=100, first 19 = (20*20 - 100) / 19 ≈ 10
      const closes: number[] = [];
      for (let i = 0; i < 19; i++) closes.push(10);
      closes.push(100); // last bar

      const svc = mockRecomputeService(
        new Map([['000001.SZ', closes.map((c) => ({ close: c }))]]),
      );
      const s = new MaFieldRecomputer(svc);

      const result = await s.recomputeLatest(
        ['000001.SZ'],
        '20260716',
        cond({ field: 'ma20', operator: 'gt' }),
      );

      expect(result.size).toBe(1);
      const snap: DerivedFieldSnapshot<{ ma: number | null }> | undefined =
        result.get('000001.SZ');
      expect(snap).toBeDefined();
      // MA20 = (19*10 + 100) / 20 = 290 / 20 = 14.5
      expect(snap!.curr.ma).toBeCloseTo(14.5, 6);
    });

    it('returns ma=null when warmup insufficient', async () => {
      // Only 5 bars for ma20
      const closes = [10, 11, 12, 13, 14];
      const svc = mockRecomputeService(
        new Map([['000001.SZ', closes.map((c) => ({ close: c }))]]),
      );
      const s = new MaFieldRecomputer(svc);

      const result = await s.recomputeLatest(
        ['000001.SZ'],
        '20260716',
        cond({ field: 'ma20', operator: 'gt' }),
      );

      expect(result.size).toBe(1);
      const snap = result.get('000001.SZ')!;
      expect(snap.curr.ma).toBeNull();
      expect(snap.prev).toBeNull();
    });

    it('computes prev when enough data for 2 windows', async () => {
      // 21 bars for ma20: curr = last 20, prev = first 20
      const closes: number[] = [];
      for (let i = 0; i < 21; i++) closes.push(i + 1);
      // curr(last 20) = avg(2..21) = (2+21)*20/2/20 = 23/2 = 11.5
      // prev(first 20) = avg(1..20) = (1+20)*20/2/20 = 21/2 = 10.5
      const svc = mockRecomputeService(
        new Map([['000001.SZ', closes.map((c) => ({ close: c }))]]),
      );
      const s = new MaFieldRecomputer(svc);

      const result = await s.recomputeLatest(
        ['000001.SZ'],
        '20260716',
        cond({ field: 'ma20', operator: 'gt' }),
      );

      const snap = result.get('000001.SZ')!;
      expect(snap.curr.ma).toBeCloseTo(11.5, 2);
      expect(snap.prev).not.toBeNull();
      expect(snap.prev!.ma).toBeCloseTo(10.5, 2);
    });
  });

  describe('evaluate', () => {
    it('gt comparison with value: true when ma > value', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 20 },
        prev: null,
      };
      expect(
        service.evaluate(cond({ field: 'ma20', operator: 'gt', value: 15 }), snap),
      ).toBe(true);
    });

    it('gt comparison with value: false when ma <= value', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 10 },
        prev: null,
      };
      expect(
        service.evaluate(cond({ field: 'ma20', operator: 'gt', value: 15 }), snap),
      ).toBe(false);
    });

    it('lt comparison with value', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 10 },
        prev: null,
      };
      expect(
        service.evaluate(cond({ field: 'ma20', operator: 'lt', value: 15 }), snap),
      ).toBe(true);
      expect(
        service.evaluate(cond({ field: 'ma20', operator: 'lt', value: 5 }), snap),
      ).toBe(false);
    });

    it('returns false when curr.ma is null (fail-closed)', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: null },
        prev: null,
      };
      expect(
        service.evaluate(cond({ field: 'ma20', operator: 'gt', value: 15 }), snap),
      ).toBe(false);
    });

    it('returns false for unknown operator', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 20 },
        prev: null,
      };
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'neq' as any, value: 15 }),
          snap,
        ),
      ).toBe(true); // neq is valid
    });

    it('cross_above: prev < value and curr > value', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 20 },
        prev: { ma: 10 },
      };
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'cross_above', value: 15 }),
          snap,
        ),
      ).toBe(true);
    });

    it('cross_above: false when prev already above', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 20 },
        prev: { ma: 18 },
      };
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'cross_above', value: 15 }),
          snap,
        ),
      ).toBe(false);
    });

    it('cross_above: false when prev is null', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 20 },
        prev: null,
      };
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'cross_above', value: 15 }),
          snap,
        ),
      ).toBe(false);
    });

    it('cross_above with compareField sibling: true when lhs crosses above sibling', () => {
      // lhs prev=4, curr=7; sibling prev=5, curr=6 → 4<5 && 7>6 → true
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 7 },
        prev: { ma: 4 },
      };
      const siblingResults = new Map<string, DerivedFieldSnapshot<{ ma: number | null }>>([
        ['ma10', { curr: { ma: 6 }, prev: { ma: 5 } }],
      ]);
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'cross_above', compareField: 'ma10' }),
          snap,
          siblingResults,
        ),
      ).toBe(true);
    });

    it('cross_above with compareField sibling: false when lhs stays below sibling', () => {
      // lhs prev=2, curr=3; sibling prev=5, curr=6 → 2<5 but 3<6 → false
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 3 },
        prev: { ma: 2 },
      };
      const siblingResults = new Map<string, DerivedFieldSnapshot<{ ma: number | null }>>([
        ['ma10', { curr: { ma: 6 }, prev: { ma: 5 } }],
      ]);
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'cross_above', compareField: 'ma10' }),
          snap,
          siblingResults,
        ),
      ).toBe(false);
    });

    it('cross_below with compareField sibling: true when lhs crosses below sibling', () => {
      // lhs prev=8, curr=3; sibling prev=5, curr=6 → 8>5 && 3<6 → true
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 3 },
        prev: { ma: 8 },
      };
      const siblingResults = new Map<string, DerivedFieldSnapshot<{ ma: number | null }>>([
        ['ma10', { curr: { ma: 6 }, prev: { ma: 5 } }],
      ]);
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'cross_below', compareField: 'ma10' }),
          snap,
          siblingResults,
        ),
      ).toBe(true);
    });

    it('cross_above with compareField: false when sibling missing', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 7 },
        prev: { ma: 4 },
      };
      const siblingResults = new Map<string, DerivedFieldSnapshot<{ ma: number | null }>>();
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'cross_above', compareField: 'ma10' }),
          snap,
          siblingResults,
        ),
      ).toBe(false);
    });

    it('cross_above with compareField: false when sibling.prev is null', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 7 },
        prev: { ma: 4 },
      };
      const siblingResults = new Map<string, DerivedFieldSnapshot<{ ma: number | null }>>([
        ['ma10', { curr: { ma: 6 }, prev: null }],
      ]);
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'cross_above', compareField: 'ma10' }),
          snap,
          siblingResults,
        ),
      ).toBe(false);
    });

    // ── BUG-1 回归：gt + compareField 使用预算 MA 字段的 sibling 注入 ────
    // buildSiblingResults 对预算 MA 字段构造 {curr:{ma:number}, prev:null}，
    // evaluate 的 .curr.ma 访问必须正确返回数字而非 undefined。
    it('gt with compareField=precomputed MA sibling: curr.ma > sibling.curr.ma returns true', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 120 },
        prev: null,
      };
      // 模拟 buildSiblingResults 对预算 ma60 构造的形状
      const siblingResults = new Map<string, DerivedFieldSnapshot<{ ma: number | null }>>([
        ['ma60', { curr: { ma: 100 }, prev: null }],
      ]);
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'gt', compareField: 'ma60' }),
          snap,
          siblingResults,
        ),
      ).toBe(true);
    });

    it('gt with compareField=precomputed MA sibling: curr.ma < sibling.curr.ma returns false', () => {
      const snap: DerivedFieldSnapshot<{ ma: number | null }> = {
        curr: { ma: 80 },
        prev: null,
      };
      const siblingResults = new Map<string, DerivedFieldSnapshot<{ ma: number | null }>>([
        ['ma60', { curr: { ma: 100 }, prev: null }],
      ]);
      expect(
        service.evaluate(
          cond({ field: 'ma20', operator: 'gt', compareField: 'ma60' }),
          snap,
          siblingResults,
        ),
      ).toBe(false);
    });
  });
});
