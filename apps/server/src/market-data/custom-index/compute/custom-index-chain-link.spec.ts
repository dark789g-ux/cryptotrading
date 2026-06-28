/** 版本切换日 Laspeyres chain link 连续性（spec 有、Python 无） */

import type {
  ComponentBar,
  ComputeContext,
  MemberWeight,
  StockMeta,
  WeightVersion,
} from './custom-index-compute.types';
import { computePriceIndexQuotes } from './custom-index-price-index';

function bar(params: {
  code: string;
  tradeDate: string;
  close: number;
  prev: number | null;
}): ComponentBar {
  const { code, tradeDate, close, prev } = params;
  return {
    conCode: code,
    tradeDate,
    open: close,
    high: close,
    low: close,
    close,
    preClose: prev,
    vol: 1000.0,
    amount: 100.0,
    price: close,
    pricePrev: prev,
    pricePrevRaw: prev,
    openPrice: close,
    highPrice: close,
    lowPrice: close,
  };
}

describe('custom index chain link on weight version switch', () => {
  const stockA = '600000.SH';
  const stockB = '600001.SH';
  const stockC = '600002.SH';

  const v1Members: MemberWeight[] = [
    { conCode: stockA, weight: 0.5 },
    { conCode: stockB, weight: 0.5 },
  ];
  const v2Members: MemberWeight[] = [
    { conCode: stockA, weight: 0.5 },
    { conCode: stockC, weight: 0.5 },
  ];

  const versions: WeightVersion[] = [
    {
      id: 1,
      effectiveDate: '20240102',
      expireDate: '20240103',
      weightMethod: 'equal',
      members: v1Members,
    },
    {
      id: 2,
      effectiveDate: '20240104',
      expireDate: null,
      weightMethod: 'equal',
      members: v2Members,
    },
  ];

  const dates = ['20240102', '20240103', '20240104', '20240105'];
  const barsByDate: ComputeContext['barsByDate'] = {
    '20240102': {
      [stockA]: bar({ code: stockA, tradeDate: '20240102', close: 10.0, prev: null }),
      [stockB]: bar({ code: stockB, tradeDate: '20240102', close: 20.0, prev: null }),
    },
    '20240103': {
      [stockA]: bar({ code: stockA, tradeDate: '20240103', close: 11.0, prev: 10.0 }),
      [stockB]: bar({ code: stockB, tradeDate: '20240103', close: 22.0, prev: 20.0 }),
    },
    '20240104': {
      [stockA]: bar({ code: stockA, tradeDate: '20240104', close: 12.0, prev: 11.0 }),
      [stockC]: bar({ code: stockC, tradeDate: '20240104', close: 30.0, prev: 28.0 }),
    },
    '20240105': {
      [stockA]: bar({ code: stockA, tradeDate: '20240105', close: 13.0, prev: 12.0 }),
      [stockC]: bar({ code: stockC, tradeDate: '20240105', close: 33.0, prev: 30.0 }),
    },
  };

  const stockMeta: Record<string, StockMeta> = {
    [stockA]: { listDate: null, delistDate: null },
    [stockB]: { listDate: null, delistDate: null },
    [stockC]: { listDate: null, delistDate: null },
  };

  const ctx: ComputeContext = {
    tradeDates: dates,
    barsByDate,
    stockMeta,
    adjLatest: {},
    warnings: [],
  };

  it('切换日 preClose 等于前日 close，无基点重置跳空', () => {
    const quotes = computePriceIndexQuotes({
      versions,
      ctx,
      baseDate: '20240102',
      basePoint: 1000.0,
    });

    expect(quotes).toHaveLength(4);

    const byDate = Object.fromEntries(quotes.map((q) => [q.tradeDate, q]));
    const dayBeforeSwitch = byDate['20240103'];
    const switchDay = byDate['20240104'];

    expect(switchDay.preClose).toBeCloseTo(dayBeforeSwitch.close!, 6);
    expect(switchDay.close).not.toBeCloseTo(1000.0, 0);
    expect(Math.abs(switchDay.close! - switchDay.preClose!)).toBeLessThan(
      dayBeforeSwitch.close! * 0.5,
    );
  });

  it('切换日 close 符合新权重 Laspeyres 链式收益', () => {
    const quotes = computePriceIndexQuotes({
      versions,
      ctx,
      baseDate: '20240102',
      basePoint: 1000.0,
    });

    const byDate = Object.fromEntries(quotes.map((q) => [q.tradeDate, q]));
    const prevClose = byDate['20240103'].close!;
    const switchBars = barsByDate['20240104'];
    const ra =
      switchBars[stockA].price / switchBars[stockA].pricePrev! - 1.0;
    const rc =
      switchBars[stockC].price / switchBars[stockC].pricePrev! - 1.0;
    const weightedRet = 0.5 * ra + 0.5 * rc;
    const expectedClose = prevClose * (1.0 + weightedRet);

    expect(byDate['20240104'].close).toBeCloseTo(expectedClose, 4);
  });

  it('切换日后序列继续链式演算', () => {
    const quotes = computePriceIndexQuotes({
      versions,
      ctx,
      baseDate: '20240102',
      basePoint: 1000.0,
    });

    const byDate = Object.fromEntries(quotes.map((q) => [q.tradeDate, q]));
    const switchClose = byDate['20240104'].close!;
    const dayBars = barsByDate['20240105'];
    const ra = dayBars[stockA].price / dayBars[stockA].pricePrev! - 1.0;
    const rc = dayBars[stockC].price / dayBars[stockC].pricePrev! - 1.0;
    const expectedClose = switchClose * (1.0 + 0.5 * ra + 0.5 * rc);

    expect(byDate['20240105'].close).toBeCloseTo(expectedClose, 4);
    expect(byDate['20240105'].preClose).toBeCloseTo(switchClose, 6);
  });
});
