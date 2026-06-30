/**
 * ExitRulesEditor 纯校验逻辑单测（exitRulesValidation.ts）。
 *
 * 覆盖 spec 05 §2 的前端即时校验：
 *  - 非空
 *  - 恰一条 max_hold
 *  - 同 type 至多一条
 *  - 逐 param 落范围（区间端点开/闭、int 整数性）
 *
 * 范围 meta 是后端 `exit-rule-types` 的真实形状缩样（与 create-strategy.dto.ts 一致）。
 */
import { describe, it, expect } from 'vitest'
import type { ExitRuleDef, ExitRuleTypeMeta } from '@cryptotrading/shared-types'
import {
  buildDefaultRule,
  indexMetaByType,
  paramInRange,
  validateExitRules,
} from '../strategy/strategy-modal/exitRulesValidation'

const META: ExitRuleTypeMeta[] = [
  { type: 'stop_loss', label: '止损', params: [{ name: 'pct', valueType: 'float', min: 0, max: 1, minInclusive: false, maxInclusive: false, default: 0.08 }] },
  { type: 'ma_break', label: '跌破均线', params: [{ name: 'period', valueType: 'int', min: 2, max: 250, minInclusive: true, maxInclusive: true, default: 5 }] },
  { type: 'max_hold', label: '最大持仓', params: [{ name: 'days', valueType: 'int', min: 1, max: 250, minInclusive: true, maxInclusive: true, default: 20 }] },
  { type: 'take_profit', label: '止盈', params: [{ name: 'pct', valueType: 'float', min: 0, max: 5, minInclusive: false, maxInclusive: true, default: 0.15 }] },
  { type: 'trailing_stop', label: '移动止损', params: [{ name: 'pct', valueType: 'float', min: 0, max: 1, minInclusive: false, maxInclusive: false, default: 0.1 }] },
]
const M = indexMetaByType(META)

const maxHold = (days = 20): ExitRuleDef => ({ type: 'max_hold', params: { days } })
const stopLoss = (pct = 0.08): ExitRuleDef => ({ type: 'stop_loss', params: { pct } })

describe('validateExitRules', () => {
  it('空列表 → 报错', () => {
    expect(validateExitRules([], M)).toContain('至少要有一条出场规则')
  })

  it('合法（含一条 max_hold + 一条 stop_loss）→ 无错误', () => {
    expect(validateExitRules([stopLoss(), maxHold()], M)).toEqual([])
  })

  it('缺 max_hold → 报错', () => {
    const errs = validateExitRules([stopLoss()], M)
    expect(errs.some((e) => e.includes('max_hold'))).toBe(true)
  })

  it('同 type 重复（两条 stop_loss）→ 报错', () => {
    const errs = validateExitRules([stopLoss(0.05), stopLoss(0.08), maxHold()], M)
    expect(errs.some((e) => e.includes('至多一条'))).toBe(true)
  })

  it('param 越界（stop_loss pct=1，开区间上界不含）→ 报错', () => {
    const errs = validateExitRules([{ type: 'stop_loss', params: { pct: 1 } }, maxHold()], M)
    expect(errs.some((e) => e.includes('越界'))).toBe(true)
  })

  it('take_profit pct=5 合法（上界闭区间含 5）→ 无范围错', () => {
    const errs = validateExitRules([{ type: 'take_profit', params: { pct: 5 } }, maxHold()], M)
    expect(errs).toEqual([])
  })

  it('max_hold days 非整数 → 报错', () => {
    const errs = validateExitRules([{ type: 'max_hold', params: { days: 20.5 } }], M)
    expect(errs.some((e) => e.includes('越界'))).toBe(true)
  })

  it('max_hold days 缺失（空 params）→ 报错', () => {
    const errs = validateExitRules([{ type: 'max_hold', params: {} }], M)
    expect(errs.some((e) => e.includes('越界'))).toBe(true)
  })
})

describe('paramInRange', () => {
  const pctOpen = META[0].params[0] // stop_loss pct ∈ (0,1)
  const periodInt = META[1].params[0] // ma_break period ∈ [2,250] int

  it('开区间下界 0 不含 → false', () => {
    expect(paramInRange(0, pctOpen)).toBe(false)
  })
  it('开区间内 0.5 → true', () => {
    expect(paramInRange(0.5, pctOpen)).toBe(true)
  })
  it('闭区间端点 2 含 → true', () => {
    expect(paramInRange(2, periodInt)).toBe(true)
  })
  it('int 类型小数 → false', () => {
    expect(paramInRange(2.5, periodInt)).toBe(false)
  })
})

describe('buildDefaultRule', () => {
  it('用 meta 默认值造规则', () => {
    expect(buildDefaultRule(META[2])).toEqual({ type: 'max_hold', params: { days: 20 } })
  })
})
