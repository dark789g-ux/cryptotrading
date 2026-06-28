/** 价格指数 Laspeyres 链式链接单元测试（port test_price_index.py） */

import type {
  ComponentBar,
  ComputeContext,
  MemberWeight,
  StockMeta,
  WeightVersion,
} from './custom-index-compute.types';
import {
  computePriceIndexQuotes,
  computeTwoStockEqualIndex,
} from './custom-index-price-index';

function bar(params: {
  code: string;
  tradeDate: string;
  close: number;
  prev: number | null;
  vol?: number;
}): ComponentBar {
  const { code, tradeDate, close, prev, vol = 1000.0 } = params;
  return {
    conCode: code,
    tradeDate,
    open: close,
    high: close,
    low: close,
    close,
    preClose: prev,
    vol,
    amount: 100.0,
    price: close,
    pricePrev: prev,
    pricePrevRaw: prev,
    openPrice: close,
    highPrice: close,
    lowPrice: close,
  };
}

function emptyCtx(
  overrides: Partial<ComputeContext> & Pick<ComputeContext, 'tradeDates' | 'barsByDate'>,
): ComputeContext {
  return {
    stockMeta: {},
    adjLatest: {},
    warnings: [],
    ...overrides,
  };
}

describe('computeTwoStockEqualIndex', () => {
  it('两成分等权手工验算 close 序列', () => {
    const levels = computeTwoStockEqualIndex({
      dates: ['20240102', '20240103', '20240104'],
      stockAPrices: [10.0, 11.0, 12.1],
      stockBPrices: [20.0, 22.0, 24.2],
      basePoint: 1000.0,
    });
    expect(levels).toHaveLength(3);
    expect(levels[0]).toBeCloseTo(1000.0, 6);
    expect(levels[1]).toBeCloseTo(1100.0, 6);
    expect(levels[2]).toBeCloseTo(1210.0, 4);
  });
});

describe('computePriceIndexQuotes', () => {
  const members: MemberWeight[] = [
    { conCode: '600000.SH', weight: 0.5 },
    { conCode: '600001.SH', weight: 0.5 },
  ];
  const versions: WeightVersion[] = [
    {
      id: 1,
      effectiveDate: '20240102',
      expireDate: null,
      weightMethod: 'equal',
      members,
    },
  ];
  const dates = ['20240102', '20240103', '20240104'];
  const barsByDate: ComputeContext['barsByDate'] = {
    '20240102': {
      '600000.SH': bar({
        code: '600000.SH',
        tradeDate: '20240102',
        close: 10.0,
        prev: null,
      }),
      '600001.SH': bar({
        code: '600001.SH',
        tradeDate: '20240102',
        close: 20.0,
        prev: null,
      }),
    },
    '20240103': {
      '600000.SH': bar({
        code: '600000.SH',
        tradeDate: '20240103',
        close: 11.0,
        prev: 10.0,
      }),
      '600001.SH': bar({
        code: '600001.SH',
        tradeDate: '20240103',
        close: 22.0,
        prev: 20.0,
      }),
    },
    '20240104': {
      '600000.SH': bar({
        code: '600000.SH',
        tradeDate: '20240104',
        close: 12.1,
        prev: 11.0,
      }),
      '600001.SH': bar({
        code: '600001.SH',
        tradeDate: '20240104',
        close: 24.2,
        prev: 22.0,
      }),
    },
  };
  const stockMeta: Record<string, StockMeta> = {
    '600000.SH': { listDate: null, delistDate: null },
    '600001.SH': { listDate: null, delistDate: null },
  };

  it('两成分等权与手工验算一致', () => {
    const ctx = emptyCtx({ tradeDates: dates, barsByDate, stockMeta });

    const quotes = computePriceIndexQuotes({
      versions,
      ctx,
      baseDate: '20240102',
      basePoint: 1000.0,
    });
    const closes = quotes.map((q) => q.close!);
    const expected = computeTwoStockEqualIndex({
      dates,
      stockAPrices: [10.0, 11.0, 12.1],
      stockBPrices: [20.0, 22.0, 24.2],
      basePoint: 1000.0,
    });
    expect(closes).toHaveLength(expected.length);
    for (let i = 0; i < closes.length; i++) {
      expect(closes[i]).toBeCloseTo(expected[i], 4);
    }
  });

  it('base_point 落在 actual_start_date 而非 base_date', () => {
    const delayedBars: ComputeContext['barsByDate'] = {
      '20240102': {
        '600000.SH': bar({
          code: '600000.SH',
          tradeDate: '20240102',
          close: 10.0,
          prev: null,
        }),
        '600001.SH': bar({
          code: '600001.SH',
          tradeDate: '20240102',
          close: 20.0,
          prev: null,
          vol: 0,
        }),
      },
      '20240103': barsByDate['20240103'],
      '20240104': barsByDate['20240104'],
    };
    const ctx = emptyCtx({
      tradeDates: dates,
      barsByDate: delayedBars,
      stockMeta,
    });

    const quotes = computePriceIndexQuotes({
      versions,
      ctx,
      baseDate: '20240102',
      basePoint: 1000.0,
    });

    expect(quotes[0].tradeDate).toBe('20240103');
    expect(quotes[0].close).toBeCloseTo(1000.0, 6);
  });

  it('停牌 vol<=0 的成分被排除并重新归一化', () => {
    const threeMembers: MemberWeight[] = [
      { conCode: '600000.SH', weight: 1 / 3 },
      { conCode: '600001.SH', weight: 1 / 3 },
      { conCode: '600002.SH', weight: 1 / 3 },
    ];
    const threeVersions: WeightVersion[] = [
      {
        id: 1,
        effectiveDate: '20240102',
        expireDate: null,
        weightMethod: 'equal',
        members: threeMembers,
      },
    ];
    const threeMeta: Record<string, StockMeta> = {
      '600000.SH': { listDate: null, delistDate: null },
      '600001.SH': { listDate: null, delistDate: null },
      '600002.SH': { listDate: null, delistDate: null },
    };
    const threeBars: ComputeContext['barsByDate'] = {
      '20240102': {
        '600000.SH': bar({
          code: '600000.SH',
          tradeDate: '20240102',
          close: 10.0,
          prev: null,
        }),
        '600001.SH': bar({
          code: '600001.SH',
          tradeDate: '20240102',
          close: 20.0,
          prev: null,
        }),
        '600002.SH': bar({
          code: '600002.SH',
          tradeDate: '20240102',
          close: 30.0,
          prev: null,
        }),
      },
      '20240103': {
        '600000.SH': bar({
          code: '600000.SH',
          tradeDate: '20240103',
          close: 11.0,
          prev: 10.0,
        }),
        '600001.SH': bar({
          code: '600001.SH',
          tradeDate: '20240103',
          close: 22.0,
          prev: 20.0,
          vol: 0,
        }),
        '600002.SH': bar({
          code: '600002.SH',
          tradeDate: '20240103',
          close: 33.0,
          prev: 30.0,
        }),
      },
      '20240104': {
        '600000.SH': bar({
          code: '600000.SH',
          tradeDate: '20240104',
          close: 12.1,
          prev: 11.0,
        }),
        '600001.SH': bar({
          code: '600001.SH',
          tradeDate: '20240104',
          close: 24.2,
          prev: 22.0,
        }),
        '600002.SH': bar({
          code: '600002.SH',
          tradeDate: '20240104',
          close: 36.3,
          prev: 33.0,
        }),
      },
    };
    const ctx = emptyCtx({
      tradeDates: dates,
      barsByDate: threeBars,
      stockMeta: threeMeta,
    });

    const quotes = computePriceIndexQuotes({
      versions: threeVersions,
      ctx,
      baseDate: '20240102',
      basePoint: 1000.0,
    });

    const day3 = quotes.find((q) => q.tradeDate === '20240103')!;
    const ra = 11.0 / 10.0 - 1.0;
    const rc = 33.0 / 30.0 - 1.0;
    const expectedDay3 = 1000.0 * (1.0 + 0.5 * ra + 0.5 * rc);

    expect(quotes).toHaveLength(3);
    expect(day3.close).toBeCloseTo(expectedDay3, 4);
  });

  it('有效成分 <2 时跳过该日并写 warning', () => {
    const allSuspended: ComputeContext['barsByDate'] = {
      ...barsByDate,
      '20240103': {
        '600000.SH': bar({
          code: '600000.SH',
          tradeDate: '20240103',
          close: 11.0,
          prev: 10.0,
          vol: 0,
        }),
        '600001.SH': bar({
          code: '600001.SH',
          tradeDate: '20240103',
          close: 22.0,
          prev: 20.0,
          vol: 0,
        }),
      },
    };
    const warnings: Array<{ code: string; detail: Record<string, unknown> }> =
      [];
    const ctx = emptyCtx({
      tradeDates: dates,
      barsByDate: allSuspended,
      stockMeta,
      warnings,
    });

    const quotes = computePriceIndexQuotes({
      versions,
      ctx,
      baseDate: '20240102',
      basePoint: 1000.0,
      onWarning: (code, detail) => {
        warnings.push({ code, detail });
      },
    });

    expect(quotes.map((q) => q.tradeDate)).toEqual(['20240102', '20240104']);
    expect(
      warnings.some((w) => w.code === 'custom_index_insufficient_members'),
    ).toBe(true);
  });
});
