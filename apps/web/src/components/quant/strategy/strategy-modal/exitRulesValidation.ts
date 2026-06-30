/**
 * ExitRulesEditor 的纯校验逻辑（与 SFC 解耦，便于单测）。
 *
 * 范围/类型/默认值的**单一真相源在后端** `GET /quant/strategies/exit-rule-types`
 * （`ExitRuleTypeMeta[]`），前端**不硬编码范围**——本模块的范围校验全部依据传入的
 * `metaByType`（运行时从后端取）。这里只编排「非空 / 恰一条 max_hold / 同 type 至多一条 /
 * 逐 param 落范围」这些**结构性约束**，与后端 DTO（create-strategy.dto.ts）一一对应。
 */
import type { ExitRuleDef, ExitRuleType, ExitRuleParamMeta, ExitRuleTypeMeta } from '@cryptotrading/shared-types'

/** 必含一条的终止规则 type（防无限持仓，与后端 validateCrossRules 对齐） */
export const REQUIRED_MAX_HOLD_TYPE: ExitRuleType = 'max_hold'

export type MetaByType = Map<ExitRuleType, ExitRuleTypeMeta>

/** 把 `ExitRuleTypeMeta[]` 索引成 `type → meta`（供 O(1) 查 param 规格） */
export function indexMetaByType(items: ExitRuleTypeMeta[]): MetaByType {
  const m = new Map<ExitRuleType, ExitRuleTypeMeta>()
  for (const it of items) m.set(it.type, it)
  return m
}

/** 单条 param 是否落在 meta 描述的（半）开闭区间内 */
export function paramInRange(value: number, p: ExitRuleParamMeta): boolean {
  if (!Number.isFinite(value)) return false
  if (p.valueType === 'int' && !Number.isInteger(value)) return false
  const lowOk = p.minInclusive ? value >= p.min : value > p.min
  const highOk = p.maxInclusive ? value <= p.max : value < p.max
  return lowOk && highOk
}

/** 把 meta 的区间渲染成人类可读文本，如 `(0, 1)` / `[2, 250]` */
export function rangeText(p: ExitRuleParamMeta): string {
  const lo = `${p.minInclusive ? '[' : '('}${p.min}`
  const hi = `${p.max}${p.maxInclusive ? ']' : ')'}`
  return `${lo}, ${hi}`
}

/**
 * 校验整张 exit_rules 列表。返回错误信息数组（空数组 = 通过）。
 *
 * 约束（与后端 create-strategy.dto.ts 同源）：
 *  1. 非空
 *  2. 每种 type 至多一条
 *  3. 恰含一条 max_hold
 *  4. 每条规则的 params 落该 type 的范围（依据后端 meta）
 */
export function validateExitRules(
  rules: ExitRuleDef[],
  metaByType: MetaByType,
): string[] {
  const errors: string[] = []

  if (rules.length === 0) {
    errors.push('至少要有一条出场规则')
    return errors
  }

  // 同 type 至多一条
  const counts = new Map<ExitRuleType, number>()
  for (const r of rules) counts.set(r.type, (counts.get(r.type) ?? 0) + 1)
  const dup = [...counts.entries()].filter(([, c]) => c > 1).map(([t]) => t)
  if (dup.length > 0) {
    errors.push(`每种规则类型至多一条，重复：${dup.join('、')}`)
  }

  // 恰含一条 max_hold
  const maxHoldCount = counts.get(REQUIRED_MAX_HOLD_TYPE) ?? 0
  if (maxHoldCount === 0) {
    errors.push('必须含一条「最大持仓 (max_hold)」规则（终止条件，防无限持仓）')
  }

  // 逐条 param 范围
  rules.forEach((r, idx) => {
    const meta = metaByType.get(r.type)
    if (!meta) {
      errors.push(`第 ${idx + 1} 条规则类型 ${r.type} 未知（后端未声明）`)
      return
    }
    for (const p of meta.params) {
      const v = r.params[p.name]
      if (typeof v !== 'number' || !paramInRange(v, p)) {
        errors.push(
          `第 ${idx + 1} 条「${meta.label}」的 ${p.name}=${v ?? '（空）'} 越界，应 ∈ ${rangeText(p)}`,
        )
      }
    }
  })

  return errors
}

/** 用某 type 的 meta 造一条带默认 params 的规则（添加规则时用） */
export function buildDefaultRule(meta: ExitRuleTypeMeta): ExitRuleDef {
  const params: Record<string, number> = {}
  for (const p of meta.params) params[p.name] = p.default
  return { type: meta.type, params }
}
