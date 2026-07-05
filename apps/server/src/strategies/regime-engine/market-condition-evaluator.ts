/**
 * market-condition-evaluator.ts
 *
 * 大盘级条件纯函数求值器，被 regime 分类器与回测共用。
 *
 * 数据源（按配置中的 marketIndex 取当日单行）：
 *   - oamv_daily：0AMV 活跃市值指数（固定单一指数）
 *   - index_daily_quotes + index_daily_indicators：用户选定的基准大盘指数
 *
 * 字段白名单 39 个：oamv 15 个可比较数值字段 + idx 24 个字段（含 1 个 boolean）。
 * 所有比较最终都归一化为数值；boolean 字段 true=1 / false=0。
 * 任一条件 field 越界 / operator 不支持 / 任一值非法 → fail-closed 返回 false。
 */
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';

export interface OamvSnapshot {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  amvDif: number | null;
  amvDea: number | null;
  amvMacd: number | null;
  ma5: number | null;
  ma30: number | null;
  ma60: number | null;
  ma120: number | null;
  ma240: number | null;
  kdjK: number | null;
  kdjD: number | null;
  kdjJ: number | null;
}

export interface IndexQuoteSnapshot {
  open: number | null;
  high: number | null;
  low: number | null;
  close: number | null;
  preClose: number | null;
  change: number | null;
  pctChange: number | null;
  volHand: number | null;
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
  kdjK: number | null;
  kdjD: number | null;
  kdjJ: number | null;
  bbi: number | null;
  brick: number | null;
  brickDelta: number | null;
  brickXg: boolean | null;
}

export interface IndexSnapshot {
  quote: IndexQuoteSnapshot;
  indicator: IndexIndicatorSnapshot;
}

export interface MarketSnapshot {
  oamv: OamvSnapshot;
  idx: IndexSnapshot | null;
}

type FieldValue = number | boolean | null;
type FieldAccessor = (snapshot: MarketSnapshot) => FieldValue;

const FIELD_ACCESSORS: Record<string, FieldAccessor> = {
  oamv_open: (s) => s.oamv.open,
  oamv_high: (s) => s.oamv.high,
  oamv_low: (s) => s.oamv.low,
  oamv_close: (s) => s.oamv.close,
  oamv_dif: (s) => s.oamv.amvDif,
  oamv_dea: (s) => s.oamv.amvDea,
  oamv_macd: (s) => s.oamv.amvMacd,
  oamv_ma5: (s) => s.oamv.ma5,
  oamv_ma30: (s) => s.oamv.ma30,
  oamv_ma60: (s) => s.oamv.ma60,
  oamv_ma120: (s) => s.oamv.ma120,
  oamv_ma240: (s) => s.oamv.ma240,
  oamv_kdj_k: (s) => s.oamv.kdjK,
  oamv_kdj_d: (s) => s.oamv.kdjD,
  oamv_kdj_j: (s) => s.oamv.kdjJ,

  idx_open: (s) => s.idx?.quote.open ?? null,
  idx_high: (s) => s.idx?.quote.high ?? null,
  idx_low: (s) => s.idx?.quote.low ?? null,
  idx_close: (s) => s.idx?.quote.close ?? null,
  idx_pre_close: (s) => s.idx?.quote.preClose ?? null,
  idx_change: (s) => s.idx?.quote.change ?? null,
  idx_pct_change: (s) => s.idx?.quote.pctChange ?? null,
  idx_vol_hand: (s) => s.idx?.quote.volHand ?? null,
  idx_amount: (s) => s.idx?.quote.amount ?? null,
  idx_ma5: (s) => s.idx?.indicator.ma5 ?? null,
  idx_ma30: (s) => s.idx?.indicator.ma30 ?? null,
  idx_ma60: (s) => s.idx?.indicator.ma60 ?? null,
  idx_ma120: (s) => s.idx?.indicator.ma120 ?? null,
  idx_ma240: (s) => s.idx?.indicator.ma240 ?? null,
  idx_dif: (s) => s.idx?.indicator.dif ?? null,
  idx_dea: (s) => s.idx?.indicator.dea ?? null,
  idx_macd: (s) => s.idx?.indicator.macd ?? null,
  idx_kdj_k: (s) => s.idx?.indicator.kdjK ?? null,
  idx_kdj_d: (s) => s.idx?.indicator.kdjD ?? null,
  idx_kdj_j: (s) => s.idx?.indicator.kdjJ ?? null,
  idx_bbi: (s) => s.idx?.indicator.bbi ?? null,
  idx_brick: (s) => s.idx?.indicator.brick ?? null,
  idx_brick_delta: (s) => s.idx?.indicator.brickDelta ?? null,
  idx_brick_xg: (s) => s.idx?.indicator.brickXg ?? null,
};

export const MARKET_CONDITION_FIELD_WHITELIST: ReadonlySet<string> = new Set(
  Object.keys(FIELD_ACCESSORS),
);

const COMPARISON_OPERATORS = new Set([
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
  'neq',
]);

function isValidNumber(v: unknown): v is number {
  return typeof v === 'number' && Number.isFinite(v);
}

function toNumeric(v: FieldValue): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v === 'boolean') return v ? 1 : 0;
  return isValidNumber(v) ? v : null;
}

function getFieldValue(snapshot: MarketSnapshot, field: string): FieldValue {
  const accessor = FIELD_ACCESSORS[field];
  if (!accessor) return null;
  return accessor(snapshot);
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

/**
 * 对单个大盘条件求值。
 * fail-closed：field 越界 / operator 不支持 / 任一操作数为 null / 比较不成立 → false。
 */
function evaluateSingleCondition(
  snapshot: MarketSnapshot,
  condition: StrategyConditionItem,
): boolean {
  const { field, operator, value, compareField } = condition;

  if (!field || !MARKET_CONDITION_FIELD_WHITELIST.has(field)) return false;
  if (!operator || !COMPARISON_OPERATORS.has(operator)) return false;

  const left = toNumeric(getFieldValue(snapshot, field));
  if (left === null) return false;

  let right: number | null;
  if (compareField) {
    if (!MARKET_CONDITION_FIELD_WHITELIST.has(compareField)) return false;
    right = toNumeric(getFieldValue(snapshot, compareField));
  } else {
    right = isValidNumber(value) ? value : null;
  }
  if (right === null) return false;

  return compareValues(left, operator, right);
}

/**
 * 对一组大盘条件求值，所有条件必须同时命中。
 * 空条件数组视为 false（fail-closed，避免兜底象限误命中）。
 */
export function evaluateMarketConditions(
  snapshot: MarketSnapshot,
  conditions: StrategyConditionItem[],
): boolean {
  if (!Array.isArray(conditions) || conditions.length === 0) return false;
  for (const condition of conditions) {
    if (!evaluateSingleCondition(snapshot, condition)) return false;
  }
  return true;
}
