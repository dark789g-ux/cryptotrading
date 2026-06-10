/**
 * regime.classifier.ts
 *
 * 0AMV 四象限纯函数分类器（无任何依赖，TDD 先行）。
 *
 * 口径与研究侧离线 SQL 完全一致（spec 03-automation-design.md），
 * 边界 `<=` 一律归负侧：
 *   dif>0  且 macd>0  → Q1（强多头）
 *   dif>0  且 macd<=0 → Q2（多头回调）
 *   dif<=0 且 macd>0  → Q3（反弹筑底）
 *   dif<=0 且 macd<=0 → Q4（空头）
 *   任一入参 null / 非有限数（NaN/±Infinity/undefined）→ unknown（fail-closed）
 */
import { RegimeKey } from '../../entities/strategy/regime-strategy-config.entity';

export type RegimeResult = RegimeKey | 'unknown';

export function classifyRegime(
  amvDif: number | null,
  amvMacd: number | null,
): RegimeResult {
  // null / undefined / NaN / ±Infinity 一律 unknown（Number.isFinite 同时覆盖非 number 类型）
  if (!Number.isFinite(amvDif) || !Number.isFinite(amvMacd)) {
    return 'unknown';
  }
  if (amvDif > 0) {
    return amvMacd > 0 ? 'Q1' : 'Q2';
  }
  return amvMacd > 0 ? 'Q3' : 'Q4';
}
