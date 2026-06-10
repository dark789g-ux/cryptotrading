/**
 * regime-engine.validation.ts
 *
 * regime 配置 fail-fast 校验（创建配置时执行；失败抛 400 并指明字段）。
 *
 * 规则（spec 03-automation-design.md）：
 *   ① Q1~Q4 四键齐全且无未知键；
 *   ② action ∈ {trade, flat}；
 *   ③ trade 象限：entryConditions 非空数组且每项 field 命中条件系统字段白名单
 *      （ASHARE_FIELD_COL_MAP + ASHARE_INDUSTRY_AMV_COL_MAP + ASHARE_MARKET_AMV_COL_MAP 键集）；
 *      exitMode ∈ {trailing_lock, fixed_n, strategy} 且参数组合合法：
 *        fixed_n      → exitParams.N > 0；
 *        strategy     → exitParams.exitConditions 非空数组（field 同走白名单）+ maxHold > 0；
 *        trailing_lock→ exitParams.maxHold 可为 null，给了须 > 0；
 *   ④ flat 象限：entryConditions/exitMode/exitParams 必须为 null（缺省视同 null）。
 */
import { BadRequestException } from '@nestjs/common';
import {
  ASHARE_FIELD_COL_MAP,
  ASHARE_INDUSTRY_AMV_COL_MAP,
  ASHARE_MARKET_AMV_COL_MAP,
} from '../../strategy-conditions/strategy-conditions.types';
import {
  RegimeConfigMap,
  RegimeKey,
} from '../../entities/strategy/regime-strategy-config.entity';

/** A 股条件系统字段白名单 = 三个 COL_MAP 的键集（个股 + 行业 AMV + 大盘 0AMV） */
export const ASHARE_CONDITION_FIELD_WHITELIST: ReadonlySet<string> = new Set([
  ...Object.keys(ASHARE_FIELD_COL_MAP),
  ...Object.keys(ASHARE_INDUSTRY_AMV_COL_MAP),
  ...Object.keys(ASHARE_MARKET_AMV_COL_MAP),
]);

const REGIME_KEYS: RegimeKey[] = ['Q1', 'Q2', 'Q3', 'Q4'];
const EXIT_MODES = new Set(['trailing_lock', 'fixed_n', 'strategy']);

function fail(message: string): never {
  throw new BadRequestException(message);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** 条件数组校验：非空数组 + 每项 field 命中白名单（path 用于报错定位字段）。 */
function validateConditionArray(conds: unknown, path: string): void {
  if (!Array.isArray(conds) || conds.length === 0) {
    fail(`${path} 必须为非空数组`);
  }
  conds.forEach((c, i) => {
    if (!isPlainObject(c)) {
      fail(`${path}[${i}] 必须为对象`);
    }
    const field = c.field;
    if (typeof field !== 'string' || !ASHARE_CONDITION_FIELD_WHITELIST.has(field)) {
      fail(`${path}[${i}].field "${String(field)}" 不在条件系统字段白名单`);
    }
  });
}

function validatePositiveNumber(v: unknown, path: string, extra: string): void {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
    fail(`${path} 必须为 >0 的数字（${extra}）`);
  }
}

function validateTradeEntry(key: RegimeKey, entry: Record<string, unknown>): void {
  validateConditionArray(entry.entryConditions, `config.${key}.entryConditions`);

  const exitMode = entry.exitMode;
  if (typeof exitMode !== 'string' || !EXIT_MODES.has(exitMode)) {
    fail(
      `config.${key}.exitMode 非法（须为 trailing_lock|fixed_n|strategy，收到 "${String(exitMode)}"）`,
    );
  }

  const params = entry.exitParams;
  if (!isPlainObject(params)) {
    fail(`config.${key}.exitParams 必须为对象（${exitMode} 模式参数）`);
  }

  if (exitMode === 'fixed_n') {
    validatePositiveNumber(params.N, `config.${key}.exitParams.N`, 'fixed_n 持有天数');
  } else if (exitMode === 'strategy') {
    validateConditionArray(
      params.exitConditions,
      `config.${key}.exitParams.exitConditions`,
    );
    validatePositiveNumber(
      params.maxHold,
      `config.${key}.exitParams.maxHold`,
      'strategy 模式必填',
    );
  } else {
    // trailing_lock：maxHold 可为 null/缺省，给了须为 >0 的数字
    if (params.maxHold !== null && params.maxHold !== undefined) {
      validatePositiveNumber(
        params.maxHold,
        `config.${key}.exitParams.maxHold`,
        'trailing_lock 可为 null',
      );
    }
  }
}

function validateFlatEntry(key: RegimeKey, entry: Record<string, unknown>): void {
  for (const f of ['entryConditions', 'exitMode', 'exitParams']) {
    if (entry[f] !== null && entry[f] !== undefined) {
      fail(`config.${key} action=flat 时 ${f} 必须为 null`);
    }
  }
}

/**
 * 校验 regime 配置（jsonb 入参，运行时形状未知）。
 * 通过则可安全断言为 RegimeConfigMap；失败抛 BadRequestException（400）并指明字段。
 */
export function validateRegimeConfig(config: unknown): asserts config is RegimeConfigMap {
  if (!isPlainObject(config)) {
    fail('config 必须为对象（Q1~Q4 四象限齐全）');
  }

  for (const k of Object.keys(config)) {
    if (!REGIME_KEYS.includes(k as RegimeKey)) {
      fail(`config 含未知键 "${k}"（仅允许 Q1~Q4）`);
    }
  }

  for (const key of REGIME_KEYS) {
    const entry = config[key];
    if (!isPlainObject(entry)) {
      fail(`config 缺少象限 ${key}（或条目非对象）`);
    }
    const action = entry.action;
    if (action !== 'trade' && action !== 'flat') {
      fail(`config.${key}.action 非法（须为 trade|flat，收到 "${String(action)}"）`);
    }
    if (action === 'trade') {
      validateTradeEntry(key, entry);
    } else {
      validateFlatEntry(key, entry);
    }
  }
}
