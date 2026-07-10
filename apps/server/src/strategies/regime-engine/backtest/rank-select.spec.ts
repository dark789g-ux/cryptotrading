import {
  assignRanks,
  RANK_FIELD_WHITELIST,
  defaultRankDir,
} from './rank-select';

describe('assignRanks', () => {
  it('desc: higher value rank=1', () => {
    const out = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: 10 },
        { tsCode: '000001.SZ', rankValue: 20 },
      ],
      'desc',
    );
    expect(out.map((x) => x.tsCode)).toEqual(['000001.SZ', '000002.SZ']);
    expect(out[0].rank).toBe(1);
  });

  it('tie → smaller ts_code first', () => {
    const out = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: 10 },
        { tsCode: '000001.SZ', rankValue: 10 },
      ],
      'desc',
    );
    expect(out[0].tsCode).toBe('000001.SZ');
  });

  it('nulls last for both dirs', () => {
    const desc = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: null },
        { tsCode: '000001.SZ', rankValue: 1 },
      ],
      'desc',
    );
    expect(desc[0].tsCode).toBe('000001.SZ');
    const asc = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: null },
        { tsCode: '000001.SZ', rankValue: 1 },
      ],
      'asc',
    );
    expect(asc[0].tsCode).toBe('000001.SZ');
  });

  it('none: sort by ts_code only', () => {
    const out = assignRanks(
      [
        { tsCode: '000002.SZ', rankValue: null },
        { tsCode: '000001.SZ', rankValue: null },
      ],
      'asc',
      { mode: 'none' },
    );
    expect(out[0].tsCode).toBe('000001.SZ');
  });
});

describe('defaultRankDir', () => {
  it('turnover_rate → desc', () => {
    expect(defaultRankDir('turnover_rate')).toBe('desc');
  });
  it('pos_120 → asc', () => {
    expect(defaultRankDir('pos_120')).toBe('asc');
  });
});

describe('RANK_FIELD_WHITELIST', () => {
  it('contains curated fields + none', () => {
    expect(RANK_FIELD_WHITELIST.has('turnover_rate')).toBe(true);
    expect(RANK_FIELD_WHITELIST.has('none')).toBe(true);
    expect(RANK_FIELD_WHITELIST.has('oamv_macd')).toBe(false);
  });
});
