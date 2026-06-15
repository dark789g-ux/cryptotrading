/**
 * RegimeRulesEditor 单测：regime 规则列表的增删 + v-model 双向 + 空列表 + 数值 patch。
 *
 * 覆盖 spec 08 §单测要点：
 *  - 空列表 → 显「不启用」提示，无规则行
 *  - + 规则 → emit update:modelValue 长度 +1，新规则带默认 0AMV 条件 + maxPositions/positionRatio
 *  - 删规则 → 长度 -1，保留其余
 *  - ConditionRows 条件变更 → 透传回 modelValue（v-model 双向）
 *  - maxPositions/positionRatio n-input-number 改值 → patch 对应规则
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NButton, NInputNumber } from 'naive-ui'
import ConditionRows from '../strategy-conditions/ConditionRows.vue'
import RegimeRulesEditor from './RegimeRulesEditor.vue'
import type { RegimeRule } from '../../api/modules/strategy/portfolioSim'

function mountEditor(modelValue: RegimeRule[]) {
  return mount(RegimeRulesEditor, { props: { modelValue } })
}

/** 取最后一次 update:modelValue 的 payload。 */
function lastRules(w: ReturnType<typeof mountEditor>): RegimeRule[] | undefined {
  const emitted = w.emitted('update:modelValue') as unknown[][] | undefined
  if (!emitted || emitted.length === 0) return undefined
  return emitted[emitted.length - 1][0] as RegimeRule[]
}

function oneRule(): RegimeRule {
  return {
    conditions: [{ field: 'oamv_macd', operator: 'gt', value: 0 }],
    maxPositions: 2,
    positionRatio: 0.45,
  }
}

describe('RegimeRulesEditor 增删规则', () => {
  it('空列表 → 显「不启用」提示，无规则行', () => {
    const w = mountEditor([])
    expect(w.text()).toContain('不启用')
    expect(w.findAllComponents(ConditionRows)).toHaveLength(0)
  })

  it('+ 规则（空 → 1 条）→ emit 长度 1，带默认 0AMV 条件 + 正整数 maxPositions + (0,1] positionRatio', () => {
    const w = mountEditor([])
    // 「+ 规则」是头部唯一 NButton（空列表无规则行、无删除按钮）
    const addBtn = w.findAllComponents(NButton).at(-1)!
    addBtn.vm.$emit('click')
    const r = lastRules(w)
    expect(r).toBeTruthy()
    expect(r!).toHaveLength(1)
    expect(r![0].conditions.length).toBeGreaterThanOrEqual(1)
    expect(r![0].conditions[0].field).toMatch(/^oamv_/)
    expect(Number.isInteger(r![0].maxPositions)).toBe(true)
    expect(r![0].maxPositions).toBeGreaterThanOrEqual(1)
    expect(r![0].positionRatio).toBeGreaterThan(0)
    expect(r![0].positionRatio).toBeLessThanOrEqual(1)
  })

  it('+ 规则（1 → 2 条）→ emit 长度 2，保留首条', () => {
    const w = mountEditor([oneRule()])
    const addBtn = w.findAllComponents(NButton).filter((b) => b.text().includes('规则')).at(-1)!
    addBtn.vm.$emit('click')
    const r = lastRules(w)
    expect(r!).toHaveLength(2)
    expect(r![0].maxPositions).toBe(2)
    expect(r![0].positionRatio).toBe(0.45)
  })

  it('删规则（2 → 1 条）→ emit 长度 1，保留另一条', () => {
    const w = mountEditor([
      oneRule(),
      { conditions: [{ field: 'oamv_dif', operator: 'lt', value: 0 }], maxPositions: 5, positionRatio: 0.2 },
    ])
    const removeBtns = w.findAllComponents(NButton).filter((b) => b.text() === '删除')
    expect(removeBtns).toHaveLength(2)
    removeBtns[0].vm.$emit('click')
    const r = lastRules(w)
    expect(r!).toHaveLength(1)
    expect(r![0].maxPositions).toBe(5)
    expect(r![0].conditions[0].field).toBe('oamv_dif')
  })
})

describe('RegimeRulesEditor v-model 双向 + 数值 patch', () => {
  it('ConditionRows 条件变更 → 透传回 modelValue（首条 conditions 被替换）', () => {
    const w = mountEditor([oneRule()])
    const cr = w.findComponent(ConditionRows)
    const next = [{ field: 'oamv_dif', operator: 'gte', value: 1 }]
    cr.vm.$emit('update:conditions', next)
    const r = lastRules(w)
    expect(r![0].conditions).toEqual(next)
    // 其余字段不变
    expect(r![0].maxPositions).toBe(2)
    expect(r![0].positionRatio).toBe(0.45)
  })

  // maxPositions / positionRatio 的 NInputNumber 在 .regime-editor__nums 容器内（顺序固定），
  // 与 ConditionRows 内部的值输入 NInputNumber 隔离，避免全局索引错位。
  function numInputs(w: ReturnType<typeof mountEditor>) {
    const nums = w.find('.regime-editor__nums')
    return nums.findAllComponents(NInputNumber)
  }

  it('maxPositions 改值 → patch 对应规则（向下取整、≥1）', () => {
    const w = mountEditor([oneRule()])
    // .regime-editor__nums 内第一个 NInputNumber = maxPositions
    numInputs(w)[0].vm.$emit('update:value', 3)
    const r = lastRules(w)
    expect(r![0].maxPositions).toBe(3)
  })

  it('maxPositions 传 null → 回落原值（不破坏正整数性）', () => {
    const w = mountEditor([oneRule()])
    numInputs(w)[0].vm.$emit('update:value', null)
    const r = lastRules(w)
    expect(r![0].maxPositions).toBe(2)
  })

  it('positionRatio 改值 → patch 对应规则', () => {
    const w = mountEditor([oneRule()])
    // .regime-editor__nums 内第二个 NInputNumber = positionRatio
    numInputs(w)[1].vm.$emit('update:value', 0.3)
    const r = lastRules(w)
    expect(r![0].positionRatio).toBe(0.3)
  })

  it('positionRatio 越界 >1 → 夹到 1', () => {
    const w = mountEditor([oneRule()])
    numInputs(w)[1].vm.$emit('update:value', 1.5)
    const r = lastRules(w)
    expect(r![0].positionRatio).toBe(1)
  })
})
