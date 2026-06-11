/**
 * portfolio-sim.loader-helpers.spec.ts
 *
 * 装载层纯辅助函数单测：parseNumericString / qfqRatioBar / windowUnionByTsCode / extendCalendarTail。
 */
import {
  parseNumericString,
  qfqRatioBar,
  windowUnionByTsCode,
  extendCalendarTail,
} from './portfolio-sim.loader-helpers';
import { EngineTrade } from './portfolio-sim.types';

function trade(over: Partial<EngineTrade> = {}): EngineTrade {
  return {
    sourceIdx: 0,
    tsCode: '600000.SH',
    signalDate: '20240101',
    buyDate: '20240102',
    exitDate: '20240110',
    ret: 0.05,
    holdDays: 5,
    rankValue: null,
    ...over,
  };
}

describe('parseNumericString', () => {
  it('正常 numeric string → number', () => {
    expect(parseNumericString('0.05')).toBeCloseTo(0.05, 12);
    expect(parseNumericString('123.456')).toBeCloseTo(123.456, 12);
    expect(parseNumericString('-0.03')).toBeCloseTo(-0.03, 12);
  });

  it('null / undefined / 空串 → null', () => {
    expect(parseNumericString(null)).toBeNull();
    expect(parseNumericString(undefined)).toBeNull();
    expect(parseNumericString('')).toBeNull();
  });

  it('非有限值 → null', () => {
    expect(parseNumericString('abc')).toBeNull();
    expect(parseNumericString('NaN')).toBeNull();
  });
});

describe('qfqRatioBar', () => {
  it('open/close 均有 → EngineQuoteBar', () => {
    expect(qfqRatioBar('10.5', '11.2')).toEqual({ open: 10.5, close: 11.2 });
  });

  it('任一缺失 → null', () => {
    expect(qfqRatioBar(null, '11.2')).toBeNull();
    expect(qfqRatioBar('10.5', null)).toBeNull();
    expect(qfqRatioBar('', '')).toBeNull();
  });

  it('引擎只用比率：任意一致缩放（×10）盯市比率不变', () => {
    const a = qfqRatioBar('10', '12')!; // close/open = 1.2
    const b = qfqRatioBar('100', '120')!; // close/open = 1.2
    expect(a.close / a.open).toBeCloseTo(b.close / b.open, 12);
  });
});

describe('windowUnionByTsCode', () => {
  it('同 tsCode 多笔 → 取 minBuy / maxExit 并集', () => {
    const trades = [
      trade({ tsCode: 'A', buyDate: '20240102', exitDate: '20240110' }),
      trade({ tsCode: 'A', buyDate: '20240105', exitDate: '20240120' }),
      trade({ tsCode: 'A', buyDate: '20240101', exitDate: '20240108' }),
      trade({ tsCode: 'B', buyDate: '20240301', exitDate: '20240305' }),
    ];
    const m = windowUnionByTsCode(trades);
    expect(m.get('A')).toEqual({ minBuy: '20240101', maxExit: '20240120' });
    expect(m.get('B')).toEqual({ minBuy: '20240301', maxExit: '20240305' });
  });

  it('空数组 → 空 Map', () => {
    expect(windowUnionByTsCode([]).size).toBe(0);
  });
});

describe('extendCalendarTail', () => {
  it('日历已覆盖最大 exitDate → 不补', () => {
    const cal = ['20240102', '20240103', '20240110'];
    const trades = [trade({ buyDate: '20240102', exitDate: '20240110' })];
    const r = extendCalendarTail(cal, trades);
    expect(r.appendedDates).toEqual([]);
    expect(r.calendar).toEqual(cal);
  });

  it('日历末端落后 → 用 trades buy/exit 补尾（仅 > calTail 的日期，升序去重）', () => {
    const cal = ['20240102', '20240103'];
    const trades = [
      trade({ buyDate: '20240102', exitDate: '20240110' }),
      trade({ buyDate: '20240105', exitDate: '20240112' }),
    ];
    const r = extendCalendarTail(cal, trades);
    // calTail=20240103 → 补 > 该日的：20240105/20240110/20240112（20240102 不补，已在原历）
    expect(r.appendedDates).toEqual(['20240105', '20240110', '20240112']);
    expect(r.calendar).toEqual([
      '20240102',
      '20240103',
      '20240105',
      '20240110',
      '20240112',
    ]);
  });

  it('原日历为空 → 全部 trades 日期并集补入（升序去重）', () => {
    const trades = [
      trade({ buyDate: '20240102', exitDate: '20240110' }),
      trade({ buyDate: '20240102', exitDate: '20240108' }),
    ];
    const r = extendCalendarTail([], trades);
    expect(r.appendedDates).toEqual(['20240102', '20240108', '20240110']);
    expect(r.calendar).toEqual(['20240102', '20240108', '20240110']);
  });

  it('空 trades → 原样返回', () => {
    const cal = ['20240102'];
    const r = extendCalendarTail(cal, []);
    expect(r.appendedDates).toEqual([]);
    expect(r.calendar).toEqual(cal);
  });
});
