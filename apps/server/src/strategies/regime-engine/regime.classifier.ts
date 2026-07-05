import {
  MarketSnapshot,
  evaluateMarketConditions,
} from './market-condition-evaluator';
import { QuadrantEntry } from '../../entities/strategy/regime-strategy-config.entity';

export type RegimeResult = string | 'unknown';

function isValidSnapshot(snapshot: unknown): snapshot is MarketSnapshot {
  if (typeof snapshot !== 'object' || snapshot === null) return false;
  const s = snapshot as Partial<MarketSnapshot>;
  return typeof s.date === 'string' && s.targets instanceof Map;
}

function isValidQuadrant(q: unknown): q is QuadrantEntry {
  if (typeof q !== 'object' || q === null) return false;
  const qe = q as Partial<QuadrantEntry>;
  return (
    typeof qe.key === 'string' &&
    qe.key !== '' &&
    Array.isArray(qe.match)
  );
}

export function classifyRegime(
  snapshot: MarketSnapshot,
  quadrants: QuadrantEntry[],
): RegimeResult {
  if (!isValidSnapshot(snapshot)) return 'unknown';
  if (!Array.isArray(quadrants) || quadrants.length === 0) return 'unknown';

  for (const q of quadrants) {
    if (!isValidQuadrant(q)) continue;
    if (evaluateMarketConditions(snapshot, q.match)) {
      return q.key;
    }
  }
  return 'unknown';
}
