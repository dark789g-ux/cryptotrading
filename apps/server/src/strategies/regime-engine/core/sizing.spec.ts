import { computeAlloc, computeSourceKellyMult, MIN_ALLOC_YUAN } from './sizing';

describe('core/sizing', () => {
  const base = {
    quality: 0.5,
    positionRatio: 0.1,
    navRef: 1_000_000,
    anchorMode: false,
  };

  describe('computeAlloc', () => {
    it('fixed mode: mult=1', () => {
      const alloc = computeAlloc({ ...base, sizing: { mode: 'fixed', floorMult: 0.5, capMult: 1.5, kellyFraction: 0.5, kellyMaxMult: 1 } });
      expect(alloc).toBe(100_000);
    });

    it('signal_weighted: quality=0 → floorMult', () => {
      const alloc = computeAlloc({ ...base, quality: 0, sizing: { mode: 'signal_weighted', floorMult: 0.5, capMult: 1.5, kellyFraction: 0.5, kellyMaxMult: 1 } });
      expect(alloc).toBe(50_000);
    });

    it('signal_weighted: quality=1 → capMult', () => {
      const alloc = computeAlloc({ ...base, quality: 1, sizing: { mode: 'signal_weighted', floorMult: 0.5, capMult: 1.5, kellyFraction: 0.5, kellyMaxMult: 1 } });
      expect(alloc).toBeCloseTo(150_000);
    });

    it('anchorMode: bypass all modes', () => {
      const allocFixed = computeAlloc({ ...base, anchorMode: true });
      expect(allocFixed).toBe(100_000);
      const allocKelly = computeAlloc({ ...base, anchorMode: true, sizing: { mode: 'source_kelly', floorMult: 0.5, capMult: 1.5, kellyFraction: 0.5, kellyMaxMult: 1 }, sourceKellyMult: 0 });
      expect(allocKelly).toBe(100_000);
    });

    it('sized_out when alloc < MIN_ALLOC_YUAN (caller check)', () => {
      const alloc = computeAlloc({ ...base, positionRatio: 0.000001, navRef: 100 });
      expect(alloc).toBeLessThan(MIN_ALLOC_YUAN);
    });

    it('no sizing → fixed (default)', () => {
      const alloc = computeAlloc(base);
      expect(alloc).toBe(100_000);
    });

    it('effectivePositionRatio overrides base', () => {
      const alloc = computeAlloc({ ...base, effectivePositionRatio: 0.05 });
      expect(alloc).toBe(50_000);
    });
  });

  describe('computeSourceKellyMult', () => {
    it('positive kelly → clamped mult', () => {
      const rets = [0.1, 0.1, -0.05];
      const mult = computeSourceKellyMult(rets, { kellyFraction: 0.5, kellyMaxMult: 1 });
      expect(mult).toBeGreaterThan(0);
      expect(mult).toBeLessThanOrEqual(1);
    });

    it('negative kelly → 0', () => {
      const rets = [-0.1, -0.2, -0.05];
      const mult = computeSourceKellyMult(rets, { kellyFraction: 0.5, kellyMaxMult: 1 });
      expect(mult).toBe(0);
    });

    it('all losses (kelly undefined) → 0', () => {
      const rets = [-0.1, -0.2];
      const mult = computeSourceKellyMult(rets, { kellyFraction: 0.5, kellyMaxMult: 1 });
      expect(mult).toBe(0);
    });

    it('all wins (kelly undefined) → 1 with warn', () => {
      const warn = jest.fn();
      const rets = [0.1, 0.2];
      const mult = computeSourceKellyMult(rets, { kellyFraction: 0.5, kellyMaxMult: 1 }, warn);
      expect(mult).toBe(1);
      expect(warn).toHaveBeenCalled();
    });

    it('empty rets → 1 with warn (kellyF null, avgWin/avgLoss both null)', () => {
      const warn = jest.fn();
      const mult = computeSourceKellyMult([], { kellyFraction: 0.5, kellyMaxMult: 1 }, warn);
      expect(mult).toBe(1);
      expect(warn).toHaveBeenCalled();
    });
  });
});
