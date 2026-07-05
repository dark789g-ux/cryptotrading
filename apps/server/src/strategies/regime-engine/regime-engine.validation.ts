/**
 * regime-engine.validation.ts
 *
 * regime 配置 fail-fast 校验（创建/更新配置时执行；失败抛 400 并指明字段）。
 *
 * 规则（v2 参数化象限）：
 *   ① 顶层只允许 marketIndex / quadrants 两键；
 *   ② marketIndex 为非空字符串（用户选定的基准大盘指数 ts_code）；
 *   ③ quadrants 为非空数组，每项：
 *      - key: 非空字符串，英文/数字/下划线/连字符，配置内唯一；
 *      - label: 非空字符串；
 *      - match: 非空数组，每项 field 命中大盘条件白名单；
 *      - action ∈ {trade, flat}；
 *      - trade: entryConditions 非空数组（field 命中条件系统全白名单），exitMode/exitParams 合法；
 *      - flat: entryConditions / exitMode / exitParams 必须为 null；
 *   ④ 互斥性检查（checkQuadrantOverlapWarnings）仅作警告，不阻断保存。
 */
import { BadRequestException } from '@nestjs/common';
import {
  ASHARE_FIELD_COL_MAP,
  ASHARE_INDUSTRY_AMV_COL_MAP,
  ASHARE_MARKET_AMV_COL_MAP,
} from '../../strategy-conditions/strategy-conditions.types';
import { MARKET_CONDITION_FIELD_WHITELIST } from './market-condition-evaluator';
import {
  QuadrantEntry,
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

const ALLOWED_TOP_KEYS = new Set(['marketIndex', 'quadrants']);
const VALID_QUADRANT_KEY_RE = /^[a-zA-Z0-9_-]+$/;
const EXIT_MODES = new Set(['trailing_lock', 'fixed_n', 'strategy']);

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

  validateConditionArray(q.match, `${path}.match`, MARKET_CONDITION_FIELD_WHITELIST);

  const action = q.action;
  if (action !== 'trade' && action !== 'flat') {
    fail(`${path}.action 非法（须为 trade|flat，收到 "${String(action)}"）`);
  }

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
    fail('config 必须为对象（含 marketIndex 与 quadrants）');
  }

  for (const k of Object.keys(config)) {
    if (!ALLOWED_TOP_KEYS.has(k)) {
      fail(`config 含未知键 "${k}"（仅允许 marketIndex / quadrants）`);
    }
  }

  const marketIndex = config.marketIndex;
  if (typeof marketIndex !== 'string' || marketIndex.trim() === '') {
    fail('config.marketIndex 必须为非空字符串（基准大盘指数 ts_code）');
  }

  const quadrants = config.quadrants;
  if (!Array.isArray(quadrants) || quadrants.length === 0) {
    fail('config.quadrants 必须为非空数组');
  }

  const seenKeys = new Set<string>();
  quadrants.forEach((q, i) => validateQuadrant(q, i, seenKeys));
}

function conditionEqual(a: StrategyConditionItem, b: StrategyConditionItem): boolean {
  return (
    a.field === b.field &&
    a.operator === b.operator &&
    a.value === b.value &&
    a.compareField === b.compareField
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
