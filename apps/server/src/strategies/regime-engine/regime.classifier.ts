/**
 * regime.classifier.ts
 *
 * 参数化 regime 分类器。
 *
 * 不再硬编码 DIF/MACD 四象限；分类规则完全来自配置中的 quadrants[].match。
 * 对每日大盘 snapshot 按 quadrants 顺序逐一求 match，首个命中的 key 胜出；
 * 全不命中 / 输入非法 → 'unknown'（fail-closed）。
 */
import {
  MarketSnapshot,
  evaluateMarketConditions,
} from './market-condition-evaluator';
import { QuadrantEntry } from '../../entities/strategy/regime-strategy-config.entity';

export type RegimeResult = string | 'unknown';

function isValidSnapshot(snapshot: unknown): snapshot is MarketSnapshot {
  if (typeof snapshot !== 'object' || snapshot === null) return false;
  const s = snapshot as Partial<MarketSnapshot>;
  return typeof s.oamv === 'object' && s.oamv !== null;
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

/**
 * 根据大盘 snapshot 与配置的 quadrants 判定当前 regime。
 *
 * @param snapshot  大盘快照（必须含 oamv；idx 可选）
 * @param quadrants 有序象限数组；顺序 = 匹配优先级
 */
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
