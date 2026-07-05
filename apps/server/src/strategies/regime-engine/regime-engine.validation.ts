/**
 * regime-engine.validation.ts
 *
 * regime 配置 fail-fast 校验（创建/更新配置时执行；失败抛 400 并指明字段）。
 *
 * 规则（v3 分桶条件）:
 *   ① 顶层仅允许 quadrants；
 *   ② quadrants 为非空数组，每项:
 *      - key: 非空字符串，英文/数字/下划线/连字符，配置内唯一；
 *      - label: 非空字符串；
 *      - match: 非空数组，每项:
 *        · type ∈ {index, stock};
 *        · target 非空字符串;
 *        · field 在对应类型白名单内;
 *        · operator 为字符串;
 *        · value / compareField 二选一，compareField 也须命中同白名单;
 *      - action ∈ {trade, flat};
 *      - positionRatio 为 null 或 0~1 数字;
 *      - maxPositions 为 null 或正整数;
 *      - trade: entryConditions 非空数组（field 命中 A 股条件白名单），exitMode/exitParams 合法;
 *      - flat: entryConditions / exitMode / exitParams 必须为 null;
 *   ③ 互斥性检查（checkQuadrantOverlapWarnings）仅作警告，不阻断保存。
 */
import { BadRequestException } from '@nestjs/common';
import {
  ASHARE_FIELD_COL_MAP,
  ASHARE_INDUSTRY_AMV_COL_MAP,
  ASHARE_MARKET_AMV_COL_MAP,
} from '../../strategy-conditions/strategy-conditions.types';
import {
  QuadrantEntry,
  RegimeBucketCondition,
  RegimeConfigMap,
  RegimeExitMode,
} from '../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';

/** A 股条件系统字段白名单 = 个股 + 行业 AMV + 大盘 0AMV（入场/出场条件用） */
export const ASHARE_CONDITION_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  ...Object.keys(ASHARE_FIELD_COL_MAP),
  ...Object.keys(ASHARE_INDUSTRY_AMV_COL_MAP),
  ...Object.keys(ASHARE_MARKET_AMV_COL_MAP),
]);

/** 指数/大盘级分桶条件字段白名单（v3 去前缀） */
const INDEX_FIELD_WHITELIST = new Set([
  'open',
  'high',
  'low',
  'close',
  'pre_close',
  'change',
  'pct_change',
  'vol_hand',
  'amount',
  'ma5',
  'ma30',
  'ma60',
  'ma120',
  'ma240',
  'dif',
  'dea',
  'macd',
  'kdj_k',
  'kdj_d',
  'kdj_j',
  'bbi',
  'brick',
  'brick_delta',
  'brick_xg',
]);

/** 个股级分桶条件字段白名单：仅含 market-condition-evaluator 实际支持的字段。
 *  规则与 evaluator 的 STOCK_FIELD_SOURCE 保持一致：字段表达式须含表别名前缀，
 *  且前缀 ∈ {q, i, m, sa, d}；无别名前缀的字段（如 list_days）无法求值，须排除。
 */
const SUPPORTED_STOCK_FIELD_PREFIXES = new Set(['q', 'i', 'm', 'sa', 'd']);
const REGIME_BUCKET_STOCK_FIELD_WHITELIST: ReadonlySet<string> = new Set(
  Object.entries(ASHARE_FIELD_COL_MAP)
    .filter(([_, expr]) => {
      const dot = expr.indexOf('.');
      if (dot < 0) return false;
      return SUPPORTED_STOCK_FIELD_PREFIXES.has(expr.slice(0, dot));
    })
    .map(([field]) => field),
);

const ALLOWED_TOP_KEYS = new Set(['quadrants']);
const VALID_QUADRANT_KEY_RE = /^[a-zA-Z0-9_-]+$/;
const EXIT_MODES = new Set(['trailing_lock', 'fixed_n', 'strategy']);
const VALID_COMPARE_MODES = new Set(['value', 'field']);
const VALID_OPERATORS = new Set([
  'gt',
  'gte',
  'lt',
  'lte',
  'eq',
  'neq',
  'cross_above',
  'cross_below',
]);

export interface ValidationWarning {
  path: string;
  message: string;
}

function fail(message: string): never {
  throw new BadRequestException(message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validatePositiveNumber(v: unknown, path: string, extra: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    fail(`${path} 必须为 >0 的数字（${extra}）`);
  }
}

function fieldWhitelistForMatch(type: 'index' | 'stock'): ReadonlySet<string> {
  return type === 'index' ? INDEX_FIELD_WHITELIST : REGIME_BUCKET_STOCK_FIELD_WHITELIST;
}

function validateMatchCondition(c: unknown, path: string): void {
  if (!isPlainObject(c)) {
    fail(`${path} 必须为对象`);
  }

  const type = c.type;
  if (type !== 'index' && type !== 'stock') {
    fail(`${path}.type 非法（须为 index|stock，收到 "${String(type)}"）`);
  }

  const target = c.target;
  if (typeof target !== 'string' || target.trim() === '') {
    fail(`${path}.target 必须为非空字符串`);
  }

  const whitelist = fieldWhitelistForMatch(type);

  const field = c.field;
  if (typeof field !== 'string' || !whitelist.has(field)) {
    fail(`${path}.field "${String(field)}" 不在允许字段白名单`);
  }

  const operator = c.operator;
  if (typeof operator !== 'string' || !VALID_OPERATORS.has(operator)) {
    fail(
      `${path}.operator 非法（须为 gt|gte|lt|lte|eq|neq|cross_above|cross_below，收到 "${String(operator)}"）`,
    );
  }

  const compareMode = c.compareMode;
  if (compareMode !== undefined && compareMode !== null) {
    if (!VALID_COMPARE_MODES.has(compareMode as string)) {
      fail(`${path}.compareMode 非法（须为 value|field，收到 "${String(compareMode)}"）`);
    }
  }

  if (compareMode === 'field') {
    if (c.value !== undefined && c.value !== null) {
      fail(`${path}.value 在 compareMode=field 时必须为 null/undefined`);
    }
    const compareField = c.compareField;
    if (typeof compareField !== 'string' || compareField.trim() === '' || !whitelist.has(compareField)) {
      fail(`${path}.compareField 在 compareMode=field 时必须为非空且命中白名单字段`);
    }
  } else {
    if (c.compareField !== undefined && c.compareField !== null) {
      fail(`${path}.compareField 在 compareMode=value/未指定时必须为 null/undefined`);
    }
    const value = c.value;
    if (typeof value !== 'number' || !Number.isFinite(value)) {
      fail(`${path}.value 在 compareMode=value/未指定时必须为有效数字`);
    }
  }
}

/** match 数组校验：非空数组 + 每项符合 v3 分桶条件结构。 */
function validateMatchArray(match: unknown, path: string): void {
  if (!Array.isArray(match) || match.length === 0) {
    fail(`${path} 必须为非空数组`);
  }
  match.forEach((c, i) => validateMatchCondition(c, `${path}[${i}]`));
}

/** 条件数组校验：非空数组 + 每项 field 命中给定白名单。 */
function validateConditionArray(
  conds: unknown,
  path: string,
  whitelist: ReadonlySet<string>,
): void {
  if (!Array.isArray(conds) || conds.length === 0) {
    fail(`${path} 必须为非空数组`);
  }
  conds.forEach((c, i) => {
    if (!isPlainObject(c)) {
      fail(`${path}[${i}] 必须为对象`);
    }
    const field = c.field;
    if (typeof field !== 'string' || !whitelist.has(field)) {
      fail(`${path}[${i}].field "${String(field)}" 不在允许字段白名单`);
    }
    const op = c.operator;
    if (typeof op !== 'string') {
      fail(`${path}[${i}].operator 必须为字符串`);
    }
    if (c.compareField && typeof c.compareField !== 'string') {
      fail(`${path}[${i}].compareField 必须为字符串`);
    }
    if (c.compareField && !whitelist.has(c.compareField as string)) {
      fail(`${path}[${i}].compareField "${String(c.compareField)}" 不在允许字段白名单`);
    }
    if (!c.compareField && typeof c.value !== 'number') {
      fail(`${path}[${i}] 未设置 compareField 时 value 必须为数字`);
    }
  });
}

function validatePositionRatio(v: unknown, path: string): void {
  if (v === null || v === undefined) {
    return;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v < 0 || v > 1) {
    fail(`${path} 必须为 null 或 0~1 之间的数字`);
  }
}

function validateMaxPositions(v: unknown, path: string): void {
  if (v === null || v === undefined) {
    return;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    fail(`${path} 必须为 null 或正整数`);
  }
}

function validateTradeQuadrant(entry: Record<string, unknown>, path: string): void {
  validateConditionArray(
    entry.entryConditions,
    `${path}.entryConditions`,
    ASHARE_CONDITION_FIELD_WHITELIST,
  );

  const exitMode = entry.exitMode;
  if (typeof exitMode !== 'string' || !EXIT_MODES.has(exitMode)) {
    fail(
      `${path}.exitMode 非法（须为 trailing_lock|fixed_n|strategy，收到 "${String(exitMode)}"）`,
    );
  }

  const params = entry.exitParams;
  if (!isPlainObject(params)) {
    fail(`${path}.exitParams 必须为对象（${exitMode} 模式参数）`);
  }

  if (exitMode === 'fixed_n') {
    validatePositiveNumber(params.N, `${path}.exitParams.N`, 'fixed_n 持有天数');
  } else if (exitMode === 'strategy') {
    validateConditionArray(
      params.exitConditions,
      `${path}.exitParams.exitConditions`,
      ASHARE_CONDITION_FIELD_WHITELIST,
    );
    validatePositiveNumber(
      params.maxHold,
      `${path}.exitParams.maxHold`,
      'strategy 模式必填',
    );
  } else {
    // trailing_lock：maxHold 可为 null/缺省，给了须为 >0 的数字
    if (params.maxHold !== null && params.maxHold !== undefined) {
      validatePositiveNumber(
        params.maxHold,
        `${path}.exitParams.maxHold`,
        'trailing_lock 可为 null',
      );
    }
  }
}

function validateFlatQuadrant(entry: Record<string, unknown>, path: string): void {
  for (const f of ['entryConditions', 'exitMode', 'exitParams']) {
    if (entry[f] !== null && entry[f] !== undefined) {
      fail(`${path} action=flat 时 ${f} 必须为 null`);
    }
  }
}

function validateQuadrant(
  q: unknown,
  index: number,
  seenKeys: Set<string>,
): void {
  if (!isPlainObject(q)) {
    fail(`quadrants[${index}] 必须为对象`);
  }
  const path = `quadrants[${index}]`;

  const key = q.key;
  if (typeof key !== 'string' || key === '') {
    fail(`${path}.key 必须为非空字符串`);
  }
  if (!VALID_QUADRANT_KEY_RE.test(key)) {
    fail(`${path}.key "${key}" 只能包含英文、数字、下划线、连字符`);
  }
  if (seenKeys.has(key)) {
    fail(`${path}.key "${key}" 在配置内重复`);
  }
  seenKeys.add(key);

  const label = q.label;
  if (typeof label !== 'string' || label.trim() === '') {
    fail(`${path}.label 必须为非空字符串`);
  }

  validateMatchArray(q.match, `${path}.match`);

  const action = q.action;
  if (action !== 'trade' && action !== 'flat') {
    fail(`${path}.action 非法（须为 trade|flat，收到 "${String(action)}"）`);
  }

  validatePositionRatio(q.positionRatio, `${path}.positionRatio`);
  validateMaxPositions(q.maxPositions, `${path}.maxPositions`);

  if (action === 'trade') {
    validateTradeQuadrant(q, path);
  } else {
    validateFlatQuadrant(q, path);
  }
}

/**
 * 校验 regime 配置（jsonb 入参，运行时形状未知）。
 * 通过则可安全断言为 RegimeConfigMap；失败抛 BadRequestException（400）并指明字段。
 */
export function validateRegimeConfig(config: unknown): asserts config is RegimeConfigMap {
  if (!isPlainObject(config)) {
    fail('config 必须为对象（含 quadrants）');
  }

  for (const k of Object.keys(config)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      fail(`config 含未知键 "${k}"（仅允许 quadrants）`);
    }
  }

  const quadrants = config.quadrants;
  if (!Array.isArray(quadrants) || quadrants.length === 0) {
    fail('config.quadrants 必须为非空数组');
  }

  const seenKeys = new Set<string>();
  quadrants.forEach((q, i) => validateQuadrant(q, i, seenKeys));
}

function conditionEqual(a: RegimeBucketCondition, b: RegimeBucketCondition): boolean {
  return (
    a.type === b.type &&
    a.target === b.target &&
    a.field === b.field &&
    a.operator === b.operator &&
    a.value === b.value &&
    a.compareField === b.compareField &&
    a.compareMode === b.compareMode
  );
}

function quadrantsMayOverlap(a: QuadrantEntry, b: QuadrantEntry): boolean {
  if (!Array.isArray(a.match) || !Array.isArray(b.match)) return false;
  return a.match.some((ca) => b.match.some((cb) => conditionEqual(ca, cb)));
}

/**
 * 检查 quadrants 之间是否存在可能重叠的分桶条件。
 * 仅作前端警告，不阻断保存。
 */
export function checkQuadrantOverlapWarnings(quadrants: QuadrantEntry[]): ValidationWarning[] {
  const warnings: ValidationWarning[] = [];
  if (!Array.isArray(quadrants)) return warnings;
  for (let i = 0; i < quadrants.length; i++) {
    for (let j = i + 1; j < quadrants.length; j++) {
      const a = quadrants[i];
      const b = quadrants[j];
      if (quadrantsMayOverlap(a, b)) {
        warnings.push({
          path: 'quadrants',
          message: `"${a.key}" 与 "${b.key}" 的分桶条件存在相同项，可能同时命中（顺序优先）`,
        });
      }
    }
  }
  return warnings;
}
