import { buildHoldingDays, findLastIndexLE } from './build';
import { makeQuote } from './__tests__/fixtures';

describe('findLastIndexLE', () => {
  const cal = ['20260102', '20260103', '20260106', '20260107'];
  it('精确命中', () => expect(findLastIndexLE(cal, '20260106')).toBe(2));
  it('落在间隙取前一个', () => expect(findLastIndexLE(cal, '20260105')).toBe(1));
  it('早于全部 → -1', () => expect(findLastIndexLE(cal, '20260101')).toBe(-1));
  it('晚于全部 → 末位', () => expect(findLastIndexLE(cal, '20261231')).toBe(3));
});

describe('buildHoldingDays', () => {
  it('正常日：quoteMap 有行 → hasQuote=true，各字段正确映射', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map([['20260102', makeQuote(10, 11, 9.8)]]);
    const limitMap = new Map([['20260102', 12 as number | null]]);
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result).toHaveLength(1);
    const day = result[0];
    expect(day.calDate).toBe('20260102');
    expect(day.hasQuote).toBe(true);
    expect(day.qfqOpen).toBe(10);
    expect(day.qfqClose).toBe(11);
    expect(day.rawOpen).toBe(9.8);
    expect(day.upLimit).toBe(12);
    expect(day.exitSignalHit).toBe(false);
  });

  it('停牌日：quoteMap 无该 key → hasQuote=false，价格字段全 null', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map<string, any>();
    const limitMap = new Map([['20260102', 11 as number | null]]);
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    const day = result[0];
    expect(day.hasQuote).toBe(false);
    expect(day.qfqOpen).toBeNull();
    expect(day.qfqClose).toBeNull();
    expect(day.rawOpen).toBeNull();
    expect(day.upLimit).toBe(11);
  });

  it('qfqOpen 为 null → hasQuote=false（!!q && qfqOpen!==null && qfqClose!==null）', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map([['20260102', makeQuote(null, 10)]]);
    const limitMap = new Map<string, number | null>();
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result[0].hasQuote).toBe(false);
    expect(result[0].qfqOpen).toBeNull();
    expect(result[0].qfqClose).toBe(10);
  });

  it('qfqClose 为 null → hasQuote=false', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map([['20260102', makeQuote(10, null)]]);
    const limitMap = new Map<string, number | null>();
    const hitSet = new Set<string>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result[0].hasQuote).toBe(false);
    expect(result[0].qfqOpen).toBe(10);
    expect(result[0].qfqClose).toBeNull();
  });

  it('limitMap 缺 key → upLimit null', () => {
    const windowDates = ['20260102'];
    const quoteMap = new Map([['20260102', makeQuote(10, 10)]]);
    const limitMap = new Map<string, number | null>();

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, new Set<string>());

    expect(result[0].upLimit).toBeNull();
  });

  it('exitSignalHit idx>0 语义：hitSet 同时包含 days[0] 与 days[2]，days[0].exitSignalHit===false，days[2].exitSignalHit===true', () => {
    const windowDates = ['20260102', '20260103', '20260106'];
    const quoteMap = new Map<string, any>([
      ['20260102', makeQuote(10, 10)],
      ['20260103', makeQuote(10, 10)],
      ['20260106', makeQuote(10, 10)],
    ]);
    const limitMap = new Map<string, number | null>();
    const hitSet = new Set(['20260102', '20260106']);

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result[0].exitSignalHit).toBe(false);
    expect(result[1].exitSignalHit).toBe(false);
    expect(result[2].exitSignalHit).toBe(true);
  });

  it('空 windowDates → 返回空数组', () => {
    const result = buildHoldingDays(
      [],
      new Map<string, any>(),
      new Map<string, number | null>(),
      new Set<string>(),
    );
    expect(result).toHaveLength(0);
  });

  it('多日混合：正常日、停牌日、exitSignalHit 综合验证', () => {
    const windowDates = ['20260102', '20260103', '20260106', '20260107'];
    const quoteMap = new Map<string, any>([
      ['20260102', makeQuote(10, 10)],
      ['20260106', makeQuote(11, 12)],
      ['20260107', makeQuote(12, 13)],
    ]);
    const limitMap = new Map<string, number | null>([
      ['20260102', 11],
      ['20260106', 13],
    ]);
    const hitSet = new Set(['20260102', '20260107']);

    const result = buildHoldingDays(windowDates, quoteMap, limitMap, hitSet);

    expect(result).toHaveLength(4);

    expect(result[0].hasQuote).toBe(true);
    expect(result[0].upLimit).toBe(11);
    expect(result[0].exitSignalHit).toBe(false);

    expect(result[1].hasQuote).toBe(false);
    expect(result[1].qfqOpen).toBeNull();
    expect(result[1].upLimit).toBeNull();

    expect(result[2].hasQuote).toBe(true);
    expect(result[2].qfqOpen).toBe(11);
    expect(result[2].qfqClose).toBe(12);
    expect(result[2].exitSignalHit).toBe(false);

    expect(result[3].hasQuote).toBe(true);
    expect(result[3].upLimit).toBeNull();
    expect(result[3].exitSignalHit).toBe(true);
  });
});
