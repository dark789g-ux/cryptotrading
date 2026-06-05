/**
 * 量化「出场策略」管理共享类型（前后端单一形状源）。
 *
 * 出处 spec：`docs/superpowers/specs/2026-06-06-quant-strategy-management-design/`
 *   - 02-data-model-and-migration.md §2（exit_rules schema + 各 type params 范围）
 *   - 04-backend-nestjs.md §7（shared-types 清单）
 *
 * 后端实体 `StrategyDefinitionEntity.exitRules` 用 `ExitRuleDef[]`；
 * 前端 ExitRulesEditor / api service 共用，避免前后端形状漂移。
 *
 * ⚠ 各 param 的**范围**单一真相源在后端 `exit-rule-types` 接口（DTO）与 Python
 * `build_exit_rules`，前端**不硬编码范围**，运行时从 `ExitRuleTypeMeta` 取。
 */

/** 出场规则 type 枚举（与 Python build_exit_rules / NestJS DTO 一一对应） */
export type ExitRuleType =
  | 'stop_loss'
  | 'ma_break'
  | 'max_hold'
  | 'take_profit'
  | 'trailing_stop'

/**
 * 单条出场规则。`exit_rules` 是数组（first-match：列表顺序即优先级）。
 *
 * params 形状按 type 区分（值均为数字）：
 *   - stop_loss     : { pct: number }      pct ∈ (0,1)，正数存储（-pct 入回测）
 *   - ma_break      : { period: number }   period int ∈ [2,250]
 *   - max_hold      : { days: number }     days int ∈ [1,250]
 *   - take_profit   : { pct: number }      pct ∈ (0,5]
 *   - trailing_stop : { pct: number }      pct ∈ (0,1)
 */
export interface ExitRuleDef {
  type: ExitRuleType
  params: Record<string, number>
}

/** `GET /api/quant/strategies/:id/:version`、list 响应单元素形状（snake_case 契约） */
export interface StrategyDefinition {
  strategy_id: string
  strategy_version: string
  name: string
  exit_rules: ExitRuleDef[]
  description: string | null
  enabled: boolean
  display_order: number
  created_at: string
}

/** 单个 param 的元信息（供前端动态表单渲染输入框 + 范围提示） */
export interface ExitRuleParamMeta {
  /** param 名，如 `pct` / `period` / `days` */
  name: string
  /** 值类型：float 允许小数，int 仅整数 */
  valueType: 'float' | 'int'
  /** 下界（含否由 minInclusive 决定） */
  min: number
  /** 上界（含否由 maxInclusive 决定） */
  max: number
  /** min 是否闭区间端点（true=含，false=开） */
  minInclusive: boolean
  /** max 是否闭区间端点（true=含，false=开） */
  maxInclusive: boolean
  /** 建表单默认值 */
  default: number
}

/**
 * `GET /api/quant/strategies/exit-rule-types` 响应单元素。
 *
 * 后端是范围的**单一真相源**；前端据此渲染参数框、做即时范围提示。
 */
export interface ExitRuleTypeMeta {
  type: ExitRuleType
  /** 人类可读标签（中文） */
  label: string
  /** 该 type 的参数元信息（v1 每种 type 恰一个 param） */
  params: ExitRuleParamMeta[]
}
