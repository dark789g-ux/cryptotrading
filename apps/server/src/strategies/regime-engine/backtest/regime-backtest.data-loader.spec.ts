import { buildExitConfig } from './regime-backtest.data-loader';
import { toNum, attachMa5, collectRecentLows } from './regime-backtest.helpers';
import { ExitConfig, WindowQuote } from '../core/exit-simulator';

// ─────────────────────────────────────────────────────────────────────────────
// buildExitConfig
// ─────────────────────────────────────────────────────────────────────────────
describe('buildExitConfig', () => {
  it('fixed_n: N 取自 exitParams.N', () => {
    const cfg = buildExitConfig('fixed_n', { N: 3 });
    expect(cfg).toEqual({ mode: 'fixed_n', horizonN: 3 });
  });

  it('fixed_n: N 缺省默认 5', () => {
    const cfg = buildExitConfig('fixed_n', {});
    expect(cfg).toEqual({ mode: 'fixed_n', horizonN: 5 });
  });

  it('fixed_n: exitParams null → 默认 5', () => {
    const cfg = buildExitConfig('fixed_n', null);
    expect(cfg).toEqual({ mode: 'fixed_n', horizonN: 5 });
  });

  it('trailing_lock: 全参透传', () => {
    const cfg = buildExitConfig('trailing_lock', {
      maxHold: 20, stopRatio: 0.08, floorRatio: 0.05, floorEnabled: false, ma5RequireDown: false,
    });
    expect(cfg).toEqual({
      mode: 'trailing_lock', maxHold: 20, stopRatio: 0.08, floorRatio: 0.05, floorEnabled: false, ma5RequireDown: false,
    });
  });

  it('trailing_lock: maxHold null → undefined（无硬上限）', () => {
    const cfg = buildExitConfig('trailing_lock', { maxHold: null });
    expect(cfg.mode).toBe('trailing_lock');
    expect((cfg as any).maxHold).toBeUndefined();
  });

  it('trailing_lock: exitParams null → 全部默认值', () => {
    const cfg = buildExitConfig('trailing_lock', null);
    expect(cfg).toEqual({
      mode: 'trailing_lock', maxHold: undefined, stopRatio: 0.999, floorRatio: 0.999, floorEnabled: true, ma5RequireDown: true,
    });
  });

  it('strategy: maxHold 取自 exitParams', () => {
    const cfg = buildExitConfig('strategy', { maxHold: 15 });
    expect(cfg).toEqual({ mode: 'strategy', maxHold: 15 });
  });

  it('strategy: exitParams null → 默认 maxHold=10', () => {
    const cfg = buildExitConfig('strategy', null);
    expect(cfg).toEqual({ mode: 'strategy', maxHold: 10 });
  });

  it('phase_lock: 全参透传', () => {
    const cfg = buildExitConfig('phase_lock', { initFactor: 0.95, lockFactor: 0.97, lookback: 20 });
    expect(cfg).toEqual({ mode: 'phase_lock', initFactor: 0.95, lockFactor: 0.97, lookback: 20 });
  });

  it('phase_lock: exitParams null → 默认值', () => {
    const cfg = buildExitConfig('phase_lock', null);
    expect(cfg).toEqual({ mode: 'phase_lock', initFactor: 0.999, lockFactor: 0.999, lookback: 10 });
  });

  it('exitMode null → 兜底 fixed_n 默认 5', () => {
    const cfg = buildExitConfig(null, null);
    expect(cfg).toEqual({ mode: 'fixed_n', horizonN: 5 });
  });

  it('exitMode 未知字符串 → 兜底 fixed_n 默认 5', () => {
    const cfg = buildExitConfig('unknown_mode' as any, null);
    expect(cfg).toEqual({ mode: 'fixed_n', horizonN: 5 });
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// toNum
// ─────────────────────────────────────────────────────────────────────────────
describe('toNum', () => {
  it('正常数字字符串 → number', () => {
    expect(toNum('10.5')).toBe(10.5);
  });

  it('null → null', () => {
    expect(toNum(null)).toBeNull();
  });

  it('undefined → null', () => {
    expect(toNum(undefined)).toBeNull();
  });

  it('空字符串 → 0（Number("") === 0）', () => {
    expect(toNum('')).toBe(0);
  });

  it('NaN 字符串 → null', () => {
    expect(toNum('NaN')).toBeNull();
  });

  it('Infinity 字符串 → null', () => {
    expect(toNum('Infinity')).toBeNull();
  });

  it('整数 → 正确转换', () => {
    expect(toNum('42')).toBe(42);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// attachMa5
// ─────────────────────────────────────────────────────────────────────────────
describe('attachMa5', () => {
  function makeQuote(close: number | null): WindowQuote {
    return { qfqOpen: close, qfqClose: close, open: close };
  }

  it('连续 5 个非停牌日产生 MA5', () => {
    const dates = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const quoteMap = new Map<string, WindowQuote>([
      ['d1', makeQuote(10)],
      ['d2', makeQuote(11)],
      ['d3', makeQuote(12)],
      ['d4', makeQuote(13)],
      ['d5', makeQuote(14)],
    ]);
    attachMa5(dates, quoteMap, 5);
    expect(quoteMap.get('d1')!.ma5).toBeNull();
    expect(quoteMap.get('d2')!.ma5).toBeNull();
    expect(quoteMap.get('d3')!.ma5).toBeNull();
    expect(quoteMap.get('d4')!.ma5).toBeNull();
    expect(quoteMap.get('d5')!.ma5).toBeCloseTo((10 + 11 + 12 + 13 + 14) / 5, 10);
  });

  it('停牌日不进 MA5 窗口', () => {
    const dates = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    const quoteMap = new Map<string, WindowQuote>([
      ['d1', makeQuote(10)],
      ['d2', makeQuote(11)],
      // d3 停牌
      ['d4', makeQuote(12)],
      ['d5', makeQuote(13)],
      ['d6', makeQuote(14)],
    ]);
    attachMa5(dates, quoteMap, 5);
    expect(quoteMap.get('d3')).toBeUndefined();
    expect(quoteMap.get('d6')!.ma5).toBeCloseTo((10 + 11 + 12 + 13 + 14) / 5, 10);
  });

  it('不足 5 个 → 全部 ma5 为 null', () => {
    const dates = ['d1', 'd2'];
    const quoteMap = new Map<string, WindowQuote>([
      ['d1', makeQuote(10)],
      ['d2', makeQuote(11)],
    ]);
    attachMa5(dates, quoteMap, 5);
    expect(quoteMap.get('d1')!.ma5).toBeNull();
    expect(quoteMap.get('d2')!.ma5).toBeNull();
  });

  it('窗口滚动：第 6 个日 MA5 舍弃最早', () => {
    const dates = ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'];
    const quoteMap = new Map<string, WindowQuote>([
      ['d1', makeQuote(10)],
      ['d2', makeQuote(11)],
      ['d3', makeQuote(12)],
      ['d4', makeQuote(13)],
      ['d5', makeQuote(14)],
      ['d6', makeQuote(20)],
    ]);
    attachMa5(dates, quoteMap, 5);
    expect(quoteMap.get('d6')!.ma5).toBeCloseTo((11 + 12 + 13 + 14 + 20) / 5, 10);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// collectRecentLows
// ─────────────────────────────────────────────────────────────────────────────
describe('collectRecentLows', () => {
  it('从 buyIdx 向左收集 lookback 个非停牌 low', () => {
    const cal = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const quoteMap = new Map<string, WindowQuote>([
      ['d1', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 5 }],
      ['d2', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 6 }],
      ['d3', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 7 }],
      ['d4', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 8 }],
    ]);
    const buyIdx = 3; // buyDate = 'd4'
    const lows = collectRecentLows(cal, buyIdx, quoteMap, 3);
    expect(lows).toEqual([6, 7, 8]); // 升序：d2,d3,d4
  });

  it('停牌日跳过，不计数', () => {
    const cal = ['d1', 'd2', 'd3', 'd4', 'd5'];
    const quoteMap = new Map<string, WindowQuote>([
      ['d1', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 5 }],
      // d2 停牌
      ['d3', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 7 }],
      ['d4', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 8 }],
    ]);
    const lows = collectRecentLows(cal, 3, quoteMap, 3);
    expect(lows).toEqual([5, 7, 8]); // d1,d3,d4（d2停牌跳过）
  });

  it('lookback 大于可用 → 返回全部可用', () => {
    const cal = ['d1', 'd2', 'd3'];
    const quoteMap = new Map<string, WindowQuote>([
      ['d1', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 1 }],
      ['d2', { qfqOpen: 10, qfqClose: 10, open: 10, qfqLow: 2 }],
    ]);
    const lows = collectRecentLows(cal, 1, quoteMap, 10);
    expect(lows).toEqual([1, 2]); // 升序
  });

  it('无可用的 → 空数组', () => {
    const cal = ['d1'];
    const quoteMap = new Map<string, WindowQuote>();
    const lows = collectRecentLows(cal, 0, quoteMap, 5);
    expect(lows).toEqual([]);
  });
});
