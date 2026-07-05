import { buildExitConfig } from './exit-config.builder';

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
