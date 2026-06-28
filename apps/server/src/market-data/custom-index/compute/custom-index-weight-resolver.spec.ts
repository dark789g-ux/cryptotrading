import type { MemberWeight, WeightVersion } from './custom-index-compute.types';
import {
  normalizeWeights,
  resolvePitMembers,
  validateVersions,
} from './custom-index-weight-resolver';

function version(
  id: number,
  effectiveDate: string,
  expireDate: string | null,
  members: readonly MemberWeight[],
): WeightVersion {
  return {
    id,
    effectiveDate,
    expireDate,
    weightMethod: 'equal',
    members,
  };
}

const MEMBERS: readonly MemberWeight[] = [
  { conCode: '600000.SH', weight: 0.5 },
  { conCode: '600001.SH', weight: 0.5 },
];

describe('custom-index-weight-resolver', () => {
  describe('resolvePitMembers', () => {
    it('returns active version members for trade dates', () => {
      const versions = [
        version(1, '20240101', '20240110', MEMBERS),
        version(2, '20240111', null, MEMBERS),
      ];

      const v1 = resolvePitMembers(versions, '20240110');
      expect(v1).toHaveLength(2);
      expect(v1[0].conCode).toBe('600000.SH');

      const v2 = resolvePitMembers(versions, '20240111');
      expect(v2).toHaveLength(2);

      const empty = resolvePitMembers(versions, '20231231');
      expect(empty).toEqual([]);
    });

    it('treats expire_date as inclusive on the boundary day', () => {
      const versions = [version(1, '20240101', '20240105', MEMBERS)];

      expect(resolvePitMembers(versions, '20240105')).toHaveLength(2);
      expect(resolvePitMembers(versions, '20240106')).toEqual([]);
    });
  });

  describe('normalizeWeights', () => {
    it('renormalizes a partial weight subset to sum to 1', () => {
      const weights = { A: 0.3, B: 0.3 };
      const norm = normalizeWeights(weights);
      expect(Math.abs(Object.values(norm).reduce((s, w) => s + w, 0) - 1.0)).toBeLessThan(
        1e-9,
      );
      expect(Math.abs(norm.A - 0.5)).toBeLessThan(1e-9);
    });
  });

  describe('validateVersions', () => {
    it('rejects versions whose weights do not sum to 1', () => {
      const bad: WeightVersion[] = [
        {
          id: 1,
          effectiveDate: '20240101',
          expireDate: null,
          weightMethod: 'custom',
          members: [
            { conCode: 'A', weight: 0.6 },
            { conCode: 'B', weight: 0.3 },
          ],
        },
      ];

      expect(() => validateVersions(bad)).toThrow(/权重总和/);
    });
  });
});
