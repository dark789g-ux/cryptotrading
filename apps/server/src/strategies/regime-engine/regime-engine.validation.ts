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
 *      - match: 非空数组（单象限 quadrants.length===1 时允许空数组，通配语义，任何环境都命中），每项:
 *        · type ∈ {index, stock};
 *        · target 非空字符串;
 *        · field 在对应类型白名单内;
 *        · operator 为字符串;
 *        · value / compareField 二选一，compareField 也须命中同白名单;
 *      - action ∈ {trade, flat};
 *      - trade: positionRatio ∈ (0, 1]；maxPositions 正整数；positionRatio * maxPositions ≤ 1;
 *      - trade: rankField 必填且 ∈ 短名单；≠ none 时 rankDir ∈ {asc,desc}；
 *      - flat: positionRatio / maxPositions 可选（null/缺省）；若提供则按同范围校验;
 *      - flat: rankField / rankDir 不校验（原样保留）；
 *      - trade: entryConditions 非空数组（field 命中 A 股条件白名单），exitMode/exitParams 合法;
 *        · trailing_lock: stopRatio/floorRatio 若提供须 ∈ (0, 1]；floorEnabled/ma5RequireDown 若提供须为 boolean；maxHold 可为 null;
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
  isMatchGroup,
} from '../../entities/strategy/regime-strategy-config.entity';
import { StrategyConditionItem } from '../../entities/strategy/strategy-condition.entity';
import { RANK_FIELD_WHITELIST } from './backtest/rank-select';

/** A 股条件系统字段白名单 = 个股 + 行业 AMV + 大盘 0AMV（入场/出场条件用） */
export const ASHARE_CONDITION_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  ...Object.keys(ASHARE_FIELD_COL_MAP),
  ...Object.keys(ASHARE_INDUSTRY_AMV_COL_MAP),
  ...Object.keys(ASHARE_MARKET_AMV_COL_MAP),
]);

/** 现算字段模式集合：与 derived-field-*.recomputer.ts 的 needsRecompute 判定保持一致 */
const DERIVED_FIELD_PATTERNS = {
  /** MA 任意周期：ma10/ma15/ma20/...（ma5/30/60/120/240 走预算列，但仍合法，只是不现算） */
  MA: /^ma\d+$/,
};

/** KDJ 字段名（kdj_j/kdj_k/kdj_d）——本身在 ASHARE_FIELD_COL_MAP 里，但带 kdjParams 时走现算 */
const KDJ_FIELD_RE = /^kdj_[jkd]$/;

/**
 * 判断 field 是否属于"现算字段或现算可触发字段"。
 * 用于校验白名单放行：返回 true 时 field 合法，即使不在 ASHARE_CONDITION_FIELD_WHITELIST。
 *
 * 判定规则（与 MaFieldRecomputer.needsRecompute + KdjFieldRecomputer.needsRecompute 对齐）：
 *   - ma{N}：正则匹配即合法（无论 N 是否在 COL_MAP，因为 ma5 也在 COL_MAP 里）
 *   - kdj_j/kdj_k/kdj_d：字段名合法（无论是否带 kdjParams，带与不带都走不同路径）
 */
export function isDerivedField(field: string): boolean {
  if (typeof field !== 'string') return false;
  return DERIVED_FIELD_PATTERNS.MA.test(field) || KDJ_FIELD_RE.test(field);
}

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

const ALLOWED_TOP_KEYS = new Set(['quadrants', 'marketIndex', 'universe']);
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

/** match 数组校验：非空数组 + 每项符合 v3 分桶条件结构（叶子或 MatchGroup）。
 *  allowEmpty=true 时允许空数组（单象限通配语义），但非空数组仍逐项校验。 */
function validateMatchArray(match: unknown, path: string, allowEmpty = false): void {
  if (!Array.isArray(match)) {
    fail(`${path} 必须为数组`);
  }
  if (match.length === 0) {
    if (!allowEmpty) {
      fail(`${path} 必须为非空数组`);
    }
    return;
  }
  match.forEach((c, i) => {
    if (isMatchGroup(c)) {
      validateMatchGroup(c, `${path}[${i}]`, 0);
    } else {
      validateMatchCondition(c, `${path}[${i}]`);
    }
  });
}

/** MatchGroup 递归校验：logic 必须为 and/or，items 非空，每项递归校验。 */
function validateMatchGroup(group: unknown, path: string, depth: number): void {
  if (depth > 5) {
    fail(`${path} 嵌套深度超过 5 层（建议不超过 3-4 层）`);
  }
  if (!isPlainObject(group)) {
    fail(`${path} 必须为对象`);
  }
  const logic = (group as Record<string, unknown>).logic;
  if (logic !== 'and' && logic !== 'or') {
    fail(`${path}.logic 非法（须为 and|or，收到 "${String(logic)}"）`);
  }
  const items = (group as Record<string, unknown>).items;
  if (!Array.isArray(items) || items.length === 0) {
    fail(`${path}.items 必须为非空数组`);
  }
  items.forEach((item, i) => {
    if (isMatchGroup(item)) {
      validateMatchGroup(item, `${path}.items[${i}]`, depth + 1);
    } else {
      validateMatchCondition(item, `${path}.items[${i}]`);
    }
  });
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
    if (typeof field !== 'string' || (!whitelist.has(field) && !isDerivedField(field))) {
      fail(`${path}[${i}].field "${String(field)}" 不在允许字段白名单(预算字段 + 现算字段 ma{N}/kdj_*)`);
    }
    const op = c.operator;
    if (typeof op !== 'string') {
      fail(`${path}[${i}].operator 必须为字符串`);
    }
    if (c.compareField && typeof c.compareField !== 'string') {
      fail(`${path}[${i}].compareField 必须为字符串`);
    }
    if (c.compareField && !whitelist.has(c.compareField as string) && !isDerivedField(c.compareField as string)) {
      fail(`${path}[${i}].compareField "${String(c.compareField)}" 不在允许字段白名单`);
    }
    if (!c.compareField && typeof c.value !== 'number') {
      fail(`${path}[${i}] 未设置 compareField 时 value 必须为数字`);
    }
  });
}

/** ratio ∈ (0, 1]；required=true 时禁止 null/undefined。 */
function validatePositionRatio(v: unknown, path: string, required: boolean): void {
  if (v === null || v === undefined) {
    if (required) {
      fail(`${path} 必须为 (0, 1] 之间的数字`);
    }
    return;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) {
    fail(`${path} 必须为 (0, 1] 之间的数字`);
  }
}

/** 正整数；required=true 时禁止 null/undefined。 */
function validateMaxPositions(v: unknown, path: string, required: boolean): void {
  if (v === null || v === undefined) {
    if (required) {
      fail(`${path} 必须为正整数`);
    }
    return;
  }
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 1) {
    fail(`${path} 必须为正整数`);
  }
}

/** 可选比例字段：缺省/null 跳过；提供则须 ∈ (0, 1]。 */
function validateOptionalUnitInterval(v: unknown, path: string): void {
  if (v === null || v === undefined) {
    return;
  }
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > 1) {
    fail(`${path} 必须为 (0, 1] 之间的数字`);
  }
}

/** 可选 boolean：缺省/null 跳过；提供则须为 boolean。 */
function validateOptionalBoolean(v: unknown, path: string): void {
  if (v === null || v === undefined) {
    return;
  }
  if (typeof v !== 'boolean') {
    fail(`${path} 必须为 boolean`);
  }
}

function validateTradeQuadrant(entry: Record<string, unknown>, path: string): void {
  validatePositionRatio(entry.positionRatio, `${path}.positionRatio`, true);
  validateMaxPositions(entry.maxPositions, `${path}.maxPositions`, true);
  const r = entry.positionRatio as number;
  const maxN = entry.maxPositions as number;
  if (r * maxN > 1) {
    fail(`${path}.positionRatio * maxPositions 不能大于 1`);
  }

  const rf = entry.rankField;
  if (typeof rf !== 'string' || (!RANK_FIELD_WHITELIST.has(rf) && !isDerivedField(rf))) {
    fail(`${path}.rankField 必填且须为白名单字段或现算字段 ma{N}(含 none)`);
  }
  if (rf !== 'none') {
    if (entry.rankDir !== 'asc' && entry.rankDir !== 'desc') {
      fail(`${path}.rankDir 在 rankField≠none 时必须为 asc|desc`);
    }
  }

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

  validateOptionalBoolean(
    entry.requireAllPositionsProfitable,
    `${path}.requireAllPositionsProfitable`,
  );

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
    // 缺省字段可用默认语义通过；若提供则校验类型/范围
    validateOptionalUnitInterval(params.stopRatio, `${path}.exitParams.stopRatio`);
    validateOptionalUnitInterval(params.floorRatio, `${path}.exitParams.floorRatio`);
    validateOptionalBoolean(params.floorEnabled, `${path}.exitParams.floorEnabled`);
    validateOptionalBoolean(params.ma5RequireDown, `${path}.exitParams.ma5RequireDown`);
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
  allowEmptyMatch = false,
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

  validateMatchArray(q.match, `${path}.match`, allowEmptyMatch);

  const matchLogic = q.matchLogic;
  if (matchLogic !== undefined && matchLogic !== null) {
    if (matchLogic !== 'and' && matchLogic !== 'or') {
      fail(`${path}.matchLogic 非法(须为 'and' | 'or',收到 "${String(matchLogic)}")`);
    }
  }

  const action = q.action;
  if (action !== 'trade' && action !== 'flat') {
    fail(`${path}.action 非法（须为 trade|flat，收到 "${String(action)}"）`);
  }

  if (action === 'trade') {
    validateTradeQuadrant(q, path);
  } else {
    // flat：仓位字段可选；若提供则按同范围校验
    validatePositionRatio(q.positionRatio, `${path}.positionRatio`, false);
    validateMaxPositions(q.maxPositions, `${path}.maxPositions`, false);
    validateFlatQuadrant(q, path);
  }
}

function validateUniverse(universe: unknown): void {
  if (universe === undefined || universe === null) return;
  if (!isPlainObject(universe)) {
    fail('config.universe 必须为对象');
  }

  const mode = universe.mode;
  if (mode !== 'all' && mode !== 'watchlist' && mode !== 'symbols') {
    fail(`config.universe.mode 非法（须为 all|watchlist|symbols，收到 "${String(mode)}"）`);
  }

  if (mode === 'watchlist') {
    const id = universe.watchlistId;
    if (typeof id !== 'string' || id.trim() === '') {
      fail('config.universe.watchlistId 在 mode=watchlist 时必填');
    }
  }

  if (mode === 'symbols') {
    const symbols = universe.symbols;
    if (!Array.isArray(symbols) || symbols.length === 0) {
      fail('config.universe.symbols 在 mode=symbols 时须为非空数组');
    }
    for (let i = 0; i < symbols.length; i++) {
      const s = symbols[i];
      if (typeof s !== 'string' || s.trim() === '') {
        fail(`config.universe.symbols[${i}] 须为非空字符串`);
      }
    }
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
      fail(`config 含未知键 "${k}"（仅允许 quadrants|marketIndex|universe）`);
    }
  }

  validateUniverse(config.universe);

  const quadrants = config.quadrants;
  if (!Array.isArray(quadrants) || quadrants.length === 0) {
    fail('config.quadrants 必须为非空数组');
  }

  const seenKeys = new Set<string>();
  const isWildcard = quadrants.length === 1;
  quadrants.forEach((q, i) => validateQuadrant(q, i, seenKeys, isWildcard));
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
  return a.match.some((ca) => {
    if (isMatchGroup(ca)) return false; // MatchGroup 不做扁平重叠检测
    return b.match.some((cb) => {
      if (isMatchGroup(cb)) return false;
      return conditionEqual(ca, cb);
    });
  });
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
