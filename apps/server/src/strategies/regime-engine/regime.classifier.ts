import {
  MarketSnapshot,
  evaluateMarketConditions,
} from './market-condition-evaluator';
import { QuadrantEntry } from '../../entities/strategy/regime-strategy-config.entity';

export type RegimeResult = string | 'unknown';

/**
 * 判定是否「单象限 + 空 match」通配语义。
 * 单点定义，供 classifier / service / loader 复用，避免逻辑漂移。
 */
export function isSingleWildcardQuadrant(quadrants: unknown): boolean {
  if (!Array.isArray(quadrants) || quadrants.length !== 1) return false;
  const q = quadrants[0];
  if (typeof q !== 'object' || q === null) return false;
  const qe = q as Partial<QuadrantEntry>;
  return Array.isArray(qe.match) && qe.match.length === 0;
}

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

  // 单象限空 match（通配）：不区分大盘环境，任何交易日都命中此象限
  if (isSingleWildcardQuadrant(quadrants) && isValidQuadrant(quadrants[0])) {
    return quadrants[0].key;
  }

  for (const q of quadrants) {
    if (!isValidQuadrant(q)) continue;
    if (evaluateMarketConditions(snapshot, q.match, q.matchLogic ?? 'and')) {
      return q.key;
    }
  }
  return 'unknown';
}
