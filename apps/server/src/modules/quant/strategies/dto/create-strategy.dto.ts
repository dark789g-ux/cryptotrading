import { BadRequestException, UnprocessableEntityException } from '@nestjs/common';
import type { ExitRuleDef, ExitRuleType, ExitRuleTypeMeta } from '@cryptotrading/shared-types';

/**
 * `POST /api/quant/strategies` 请求体校验。
 *
 * 沿用项目约定（与 labels 一致，未引入 class-validator class 装饰器写法）：
 *   - interface 仅声明类型
 *   - `validate*` 函数做实际校验，controller 显式调用
 *
 * exit_rules 合法 type / params 范围权威：Python `build_exit_rules`
 * （`apps/quant-pipeline/.../exit_rules.py`）+ 本 DTO，DB 不加 CHECK（避免三处真相源）。
 *
 * params 范围（spec 02 §2 / 04 §4，与 Python build_exit_rules 一一对应）：
 *   stop_loss     : params.pct    float ∈ (0, 1)
 *   ma_break      : params.period int   ∈ [2, 250]
 *   max_hold      : params.days   int   ∈ [1, 250]
 *   take_profit   : params.pct    float ∈ (0, 5]
 *   trailing_stop : params.pct    float ∈ (0, 1)
 *
 * 跨规则约束（spec 02 §2 / 04 §4）：
 *   - exit_rules 非空
 *   - 恰含一条 max_hold（终止条件保证，防无限持仓）
 *   - v1 每种 type 至多一条
 *   不满足 → 422（UnprocessableEntity）。
 */

/** 权威与 Python build_exit_rules 一一对应；exit-rule-types 接口枚举来源 */
export const EXIT_RULE_TYPES = [
  'stop_loss',
  'ma_break',
  'max_hold',
  'take_profit',
  'trailing_stop',
] as const;

/** strategy_id / strategy_version 格式（与 scheme 编码契约一致，spec 02 §4） */
const STRATEGY_ID_RE = /^[a-z0-9_]{1,64}$/;
const STRATEGY_VERSION_RE = /^v\d+$/;

const NAME_MAX = 100;
const DESCRIPTION_MAX = 500;

/**
 * 单 param 的范围定义（后端单一真相源）。
 * `exclusive*` 表示开区间端点（不含）。
 */
interface ParamSpec {
  name: string;
  valueType: 'float' | 'int';
  min: number;
  max: number;
  minInclusive: boolean;
  maxInclusive: boolean;
  default: number;
}

/** type → 该 type 唯一 param 的范围规格（v1 每种 type 恰一个 param） */
const PARAM_SPEC: Record<ExitRuleType, ParamSpec> = {
  stop_loss: { name: 'pct', valueType: 'float', min: 0, max: 1, minInclusive: false, maxInclusive: false, default: 0.08 },
  ma_break: { name: 'period', valueType: 'int', min: 2, max: 250, minInclusive: true, maxInclusive: true, default: 5 },
  max_hold: { name: 'days', valueType: 'int', min: 1, max: 250, minInclusive: true, maxInclusive: true, default: 20 },
  take_profit: { name: 'pct', valueType: 'float', min: 0, max: 5, minInclusive: false, maxInclusive: true, default: 0.15 },
  trailing_stop: { name: 'pct', valueType: 'float', min: 0, max: 1, minInclusive: false, maxInclusive: false, default: 0.1 },
};

/** type → 中文标签（供前端 exit-rule-types 渲染） */
const TYPE_LABEL: Record<ExitRuleType, string> = {
  stop_loss: '止损',
  ma_break: '跌破均线',
  max_hold: '最大持仓',
  take_profit: '止盈',
  trailing_stop: '移动止损',
};

export interface CreateStrategyDto {
  strategy_id: string;
  strategy_version: string;
  name: string;
  exit_rules: ExitRuleDef[];
  description?: string | null;
  enabled?: boolean;
  display_order?: number;
}

/** 内部已校验形态（驼峰，与 entity 属性对齐） */
export interface ValidatedCreateStrategy {
  strategyId: string;
  strategyVersion: string;
  name: string;
  exitRules: ExitRuleDef[];
  description: string | null;
  enabled: boolean;
  displayOrder: number;
}

function isInt(n: unknown): n is number {
  return typeof n === 'number' && Number.isInteger(n);
}

function isFiniteNumber(n: unknown): n is number {
  return typeof n === 'number' && Number.isFinite(n);
}

function rangeText(spec: ParamSpec): string {
  const lo = `${spec.minInclusive ? '[' : '('}${spec.min}`;
  const hi = `${spec.max}${spec.maxInclusive ? ']' : ')'}`;
  return `${lo}, ${hi}`;
}

/**
 * 校验单条 exit_rule 的 params 是否满足该 type 的范围（越界 raise，禁夹取）。
 *
 * 抛 BadRequestException（422 由 controller 映射；见 strategies.controller.ts）。
 */
function validateExitRuleParams(type: ExitRuleType, params: Record<string, unknown>): void {
  const spec = PARAM_SPEC[type];
  const v = params[spec.name];

  // 仅允许声明的 param 名（防多余字段静默通过）
  const extraKeys = Object.keys(params).filter((k) => k !== spec.name);
  if (extraKeys.length > 0) {
    throw new UnprocessableEntityException(
      `exit_rule type=${type} 仅接受 params.${spec.name}，多余字段 [${extraKeys.join(', ')}]`,
    );
  }

  if (spec.valueType === 'int') {
    if (!isInt(v)) {
      throw new UnprocessableEntityException(
        `exit_rule type=${type} 的 params.${spec.name} 必须为整数`,
      );
    }
  } else if (!isFiniteNumber(v)) {
    throw new UnprocessableEntityException(
      `exit_rule type=${type} 的 params.${spec.name} 必须为数字`,
    );
  }

  const lowOk = spec.minInclusive ? v >= spec.min : v > spec.min;
  const highOk = spec.maxInclusive ? v <= spec.max : v < spec.max;
  if (!lowOk || !highOk) {
    throw new UnprocessableEntityException(
      `exit_rule type=${type} 的 params.${spec.name}=${v} 越界，应 ∈ ${rangeText(spec)}`,
    );
  }
}

/**
 * 跨规则约束：非空 + 恰一条 max_hold + 每种 type 至多一条。
 *
 * 抛 BadRequestException（422 由 controller 映射）。
 */
function validateCrossRules(rules: ExitRuleDef[]): void {
  if (rules.length === 0) {
    throw new UnprocessableEntityException('exit_rules 不得为空');
  }

  const counts = new Map<string, number>();
  for (const r of rules) {
    counts.set(r.type, (counts.get(r.type) ?? 0) + 1);
  }

  // 每种 type 至多一条
  const dup = [...counts.entries()].filter(([, c]) => c > 1).map(([t]) => t);
  if (dup.length > 0) {
    throw new UnprocessableEntityException(
      `exit_rules 中每种 type 至多一条，重复：[${dup.join(', ')}]`,
    );
  }

  // 恰含一条 max_hold
  const maxHoldCount = counts.get('max_hold') ?? 0;
  if (maxHoldCount !== 1) {
    throw new UnprocessableEntityException(
      `exit_rules 必须恰含一条 max_hold（终止条件，防无限持仓），实际 ${maxHoldCount} 条`,
    );
  }
}

/** 校验一条 exit_rule 的结构（type 合法 + params 是对象 + 范围）→ 规整后的 ExitRuleDef */
function validateOneRule(raw: unknown, idx: number): ExitRuleDef {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new UnprocessableEntityException(`exit_rules[${idx}] 必须是对象`);
  }
  const obj = raw as Record<string, unknown>;

  if (typeof obj.type !== 'string' || !EXIT_RULE_TYPES.includes(obj.type as ExitRuleType)) {
    throw new UnprocessableEntityException(
      `exit_rules[${idx}].type 必须 ∈ {${EXIT_RULE_TYPES.join('|')}}，实际 ${JSON.stringify(obj.type)}`,
    );
  }
  const type = obj.type as ExitRuleType;

  if (!obj.params || typeof obj.params !== 'object' || Array.isArray(obj.params)) {
    throw new UnprocessableEntityException(`exit_rules[${idx}].params 必须为对象`);
  }
  const params = obj.params as Record<string, unknown>;

  validateExitRuleParams(type, params);

  return { type, params: params as Record<string, number> };
}

/**
 * 校验 + 规整 exit_rules 数组（含逐条范围 + 跨规则约束）。
 *
 * 落库前 service 会再调一次（spec 04 §5：create 落库前再跑一遍）。
 */
export function validateExitRules(input: unknown): ExitRuleDef[] {
  if (!Array.isArray(input)) {
    throw new UnprocessableEntityException('exit_rules 必须为数组');
  }
  const rules = input.map((r, i) => validateOneRule(r, i));
  validateCrossRules(rules);
  return rules;
}

export function validateCreateStrategy(input: unknown): ValidatedCreateStrategy {
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    throw new BadRequestException('body 必须是对象');
  }
  const body = input as Record<string, unknown>;

  // strategy_id
  if (typeof body.strategy_id !== 'string' || !STRATEGY_ID_RE.test(body.strategy_id)) {
    throw new BadRequestException('strategy_id 必须匹配 /^[a-z0-9_]{1,64}$/');
  }
  const strategyId = body.strategy_id;

  // strategy_version
  if (typeof body.strategy_version !== 'string' || !STRATEGY_VERSION_RE.test(body.strategy_version)) {
    throw new BadRequestException('strategy_version 必须匹配 /^v\\d+$/（如 v1）');
  }
  const strategyVersion = body.strategy_version;

  // name
  if (typeof body.name !== 'string' || body.name.length === 0) {
    throw new BadRequestException('name 必填，不得为空');
  }
  if (body.name.length > NAME_MAX) {
    throw new BadRequestException(`name 长度不得超过 ${NAME_MAX}`);
  }
  const name = body.name;

  // exit_rules（数组 + 逐条范围 + 跨规则）
  const exitRules = validateExitRules(body.exit_rules);

  // description
  let description: string | null = null;
  if (body.description !== undefined && body.description !== null) {
    if (typeof body.description !== 'string') {
      throw new BadRequestException('description 必须为字符串');
    }
    if (body.description.length > DESCRIPTION_MAX) {
      throw new BadRequestException(`description 长度不得超过 ${DESCRIPTION_MAX}`);
    }
    description = body.description;
  }

  // enabled
  let enabled = true;
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') {
      throw new BadRequestException('enabled 必须为 boolean');
    }
    enabled = body.enabled;
  }

  // display_order
  let displayOrder = 0;
  if (body.display_order !== undefined && body.display_order !== null) {
    if (!isInt(body.display_order) || body.display_order < 0 || body.display_order > 9999) {
      throw new BadRequestException('display_order 必须为 0..9999 之间的整数');
    }
    displayOrder = body.display_order;
  }

  return { strategyId, strategyVersion, name, exitRules, description, enabled, displayOrder };
}

/**
 * `GET /api/quant/strategies/exit-rule-types` 响应载荷。
 *
 * 后端是范围的**单一真相源**；前端 ExitRulesEditor 据此渲染参数框、做范围提示，
 * **不硬编码范围**。
 */
export function getExitRuleTypesMeta(): ExitRuleTypeMeta[] {
  return EXIT_RULE_TYPES.map((type) => {
    const spec = PARAM_SPEC[type];
    return {
      type,
      label: TYPE_LABEL[type],
      params: [
        {
          name: spec.name,
          valueType: spec.valueType,
          min: spec.min,
          max: spec.max,
          minInclusive: spec.minInclusive,
          maxInclusive: spec.maxInclusive,
          default: spec.default,
        },
      ],
    };
  });
}
