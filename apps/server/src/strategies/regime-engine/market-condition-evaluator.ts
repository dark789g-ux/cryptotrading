import { RegimeBucketCondition, MatchGroup, MatchNode, isMatchGroup } from '../../entities/strategy/regime-strategy-config.entity';
import { ASHARE_FIELD_COL_MAP } from '../../strategy-conditions/strategy-conditions.types';

export interface IndexQuoteSnapshot {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  pre_close: number | null;
  change: number | null;
  pct_change: number | null;
  vol_hand: number | null;
  amount: number | null;
}

export interface IndexIndicatorSnapshot {
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  ma120: number | null;
  ma240: number | null;
  dif: number | null;
  dea: number | null;
  macd: number | null;
  kdj_k: number | null;
  kdj_d: number | null;
  kdj_j: number | null;
  bbi: number | null;
  brick: number | null;
  brick_delta: number | null;
  brick_xg: boolean | null;
}

export interface IndexTargetSnapshot {
  quote: IndexQuoteSnapshot;
  indicator: IndexIndicatorSnapshot;
}

export interface AShareQuoteSnapshot {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  volume: number | null;
  amount: number | null;
  pct_chg: number | null;
}

export interface AShareIndicatorSnapshot {
  macd_dif: number | null;
  macd_dea: number | null;
  macd_hist: number | null;
  kdj_j: number | null;
  kdj_k: number | null;
  kdj_d: number | null;
  bbi: number | null;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  ma120: number | null;
  ma240: number | null;
  atr14: number | null;
  profit_loss_ratio: number | null;
  roc10: number | null;
  roc20: number | null;
  roc60: number | null;
  brick: number | null;
  brick_delta: number | null;
  brick_xg: boolean | null;
  amv_dif: number | null;
  amv_dea: number | null;
  amv_macd: number | null;
  pos_120: number | null;
  pos_60: number | null;
  close_ma60_ratio: number | null;
  vol_ratio_60: number | null;
  vol_ratio_120: number | null;
}

export interface AShareBasicSnapshot {
  turnover_rate: number | null;
  volume_ratio: number | null;
  pe: number | null;
  pe_ttm: number | null;
  pb: number | null;
  total_mv: number | null;
  circ_mv: number | null;
}

export interface StockTargetSnapshot {
  quote: AShareQuoteSnapshot;
  indicator: AShareIndicatorSnapshot;
  basic: AShareBasicSnapshot;
}

export type TargetSnapshot = IndexTargetSnapshot | StockTargetSnapshot;

export interface MarketSnapshot {
  date: string;
  targets: Map<string, TargetSnapshot>;
  prevDate?: string;
  prevTargets?: Map<string, TargetSnapshot>;
}

type FieldValue = number | boolean | null;

const COMPARISON_OPERATORS = new Set([
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
  'neq',
  'cross_above',
  'cross_below',
]);

const INDEX_FIELD_SOURCE: Record<string, 'quote' | 'indicator'> = {
  open: 'quote',
  high: 'quote',
  low: 'quote',
  close: 'quote',
  pre_close: 'quote',
  change: 'quote',
  pct_change: 'quote',
  vol_hand: 'quote',
  amount: 'quote',
  ma5: 'indicator',
  ma30: 'indicator',
  ma60: 'indicator',
  ma120: 'indicator',
  ma240: 'indicator',
  dif: 'indicator',
  dea: 'indicator',
  macd: 'indicator',
  kdj_k: 'indicator',
  kdj_d: 'indicator',
  kdj_j: 'indicator',
  bbi: 'indicator',
  brick: 'indicator',
  brick_delta: 'indicator',
  brick_xg: 'indicator',
};

const STOCK_FIELD_SOURCE: Record<string, 'quote' | 'indicator' | 'basic'> = (() => {
  const map: Record<string, 'quote' | 'indicator' | 'basic'> = {};
  for (const [field, expr] of Object.entries(ASHARE_FIELD_COL_MAP)) {
    const dot = expr.indexOf('.');
    if (dot < 0) continue;
    const prefix = expr.slice(0, dot);
    if (prefix === 'q') {
      map[field] = 'quote';
    } else if (prefix === 'm') {
      map[field] = 'basic';
    } else if (prefix === 'i' || prefix === 'sa' || prefix === 'd') {
      map[field] = 'indicator';
    }
  }
  return map;
})();

export const MARKET_CONDITION_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  ...Object.keys(INDEX_FIELD_SOURCE),
  ...Object.keys(STOCK_FIELD_SOURCE),
]);

function isValidNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toNumeric(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'string') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function getFieldFromTarget(
  target: TargetSnapshot,
  type: 'index' | 'stock',
  field: string,
): FieldValue {
  const source = type === 'index' ? INDEX_FIELD_SOURCE[field] : STOCK_FIELD_SOURCE[field];
  if (!source) return null;
  const bucket = ((target as unknown) as Record<string, Record<string, FieldValue>>)[source];
  if (!bucket) return null;
  return bucket[field] ?? null;
}

function compareValues(left: number, operator: string, right: number): boolean {
  switch (operator) {
    case 'gt':
      return left > right;
    case 'gte':
      return left >= right;
    case 'lt':
      return left < right;
    case 'lte':
      return left <= right;
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    default:
      return false;
  }
}

function evaluateSingleCondition(
  snapshot: MarketSnapshot,
  condition: RegimeBucketCondition,
): boolean {
  const { type, target, field, operator, value, compareField, compareMode } = condition;

  if (!field || !MARKET_CONDITION_FIELD_WHITELIST.has(field)) return false;
  if (!operator || !COMPARISON_OPERATORS.has(operator)) return false;

  const targetSnapshot = snapshot.targets.get(target);
  if (!targetSnapshot) return false;

  const left = toNumeric(getFieldFromTarget(targetSnapshot, type, field));
  if (left === null) return false;

  const isCross = operator === 'cross_above' || operator === 'cross_below';

  let right: number | null;
  let prevRight: number | null = null;

  if (compareMode === 'field') {
    const cf = compareField;
    if (!cf || !MARKET_CONDITION_FIELD_WHITELIST.has(cf)) return false;
    right = toNumeric(getFieldFromTarget(targetSnapshot, type, cf));
    if (isCross) {
      const prevTargetSnapshot = snapshot.prevTargets?.get(target);
      if (!prevTargetSnapshot) return false;
      prevRight = toNumeric(getFieldFromTarget(prevTargetSnapshot, type, cf));
    }
  } else {
    right = isValidNumber(value) ? value : null;
    if (isCross) {
      prevRight = right;
    }
  }

  if (right === null || (isCross && prevRight === null)) return false;

  if (!isCross) {
    return compareValues(left, operator, right);
  }

  const prevTargetSnapshot = snapshot.prevTargets?.get(target);
  if (!prevTargetSnapshot) return false;
  const prevLeft = toNumeric(getFieldFromTarget(prevTargetSnapshot, type, field));
  if (prevLeft === null) return false;

  if (operator === 'cross_above') {
    return prevLeft <= prevRight && left > right;
  }
  return prevLeft >= prevRight && left < right;
}

/** 递归求值单个 MatchNode（叶子条件或 MatchGroup）。 */
function evaluateMatchNode(snapshot: MarketSnapshot, node: MatchNode): boolean {
  if (isMatchGroup(node)) {
    return evaluateMatchGroup(snapshot, node);
  }
  return evaluateSingleCondition(snapshot, node);
}

/** 递归求值 MatchGroup（嵌套 AND/OR），短路求值。 */
function evaluateMatchGroup(snapshot: MarketSnapshot, group: MatchGroup): boolean {
  if (!Array.isArray(group.items) || group.items.length === 0) return false;
  if (group.logic === 'or') {
    for (const node of group.items) {
      if (evaluateMatchNode(snapshot, node)) return true;
    }
    return false;
  }
  // and
  for (const node of group.items) {
    if (!evaluateMatchNode(snapshot, node)) return false;
  }
  return true;
}

export function evaluateMarketConditions(
  snapshot: MarketSnapshot,
  conditions: MatchNode[],
  logic: 'and' | 'or' = 'and',
): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  if (logic === 'or') {
    for (const c of conditions) {
      if (evaluateMatchNode(snapshot, c)) return true;
    }
    return false;
  }
  for (const c of conditions) {
    if (!evaluateMatchNode(snapshot, c)) return false;
  }
  return true;
}
