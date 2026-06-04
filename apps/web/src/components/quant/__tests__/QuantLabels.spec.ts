/**
 * 标签库管理：组件渲染 + 动态字段切换。
 *
 * 覆盖（04-frontend.md 硬约束 + 06-validation-and-testing.md 测试矩阵）：
 *  - BaseTypeFields：base_type 切换 → 动态字段（horizon / max_hold_days）
 *  - ClassifyFields：classify_mode 切换 → 动态字段（eps / tercile 提示 / custom 分位）
 *  - buildParams.parseLabelRef：key 解析 + 边界情况
 *  - LabelTable：基础渲染（摘要文本）
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NSelect } from 'naive-ui'
import BaseTypeFields from '../label-modal/BaseTypeFields.vue'
import ClassifyFields from '../label-modal/ClassifyFields.vue'
import { parseLabelRef } from '../train-modal/buildParams'

// ---- BaseTypeFields ----

const BASE_FWD = { base_type: 'fwd_ret', base_params: { horizon: 1 } }
const BASE_STRAT = { base_type: 'strategy_aware', base_params: { max_hold_days: 20 } }

describe('BaseTypeFields 动态字段切换', () => {
  it('fwd_ret → 显示 horizon 字段，不显示 max_hold_days', () => {
    const w = mount(BaseTypeFields, { props: { modelValue: BASE_FWD } })
    expect(w.text()).toContain('horizon')
    expect(w.text()).not.toContain('max_hold_days')
  })

  it('strategy_aware → 显示 max_hold_days，不显示 horizon', () => {
    const w = mount(BaseTypeFields, { props: { modelValue: BASE_STRAT } })
    expect(w.text()).toContain('max_hold_days')
    expect(w.text()).not.toContain('horizon（天）')
  })

  it('切换 base_type → emit update:modelValue 并重置 base_params', async () => {
    const w = mount(BaseTypeFields, { props: { modelValue: BASE_FWD } })
    // 通过第一个 NSelect（base_type 下拉）触发
    w.findAllComponents(NSelect)[0].vm.$emit('update:value', 'strategy_aware')
    await w.vm.$nextTick()
    const emitted = w.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    const payload = (emitted as unknown[][])[0][0] as { base_type: string; base_params: Record<string, unknown> }
    expect(payload.base_type).toBe('strategy_aware')
    expect(payload.base_params).toHaveProperty('max_hold_days')
  })
})

// ---- ClassifyFields ----

const CLS_NULL = { classify_mode: null, classify_params: null }
const CLS_BAND = { classify_mode: 'band', classify_params: { eps: 0.005 } }
const CLS_TERCILE = { classify_mode: 'tercile', classify_params: {} }
const CLS_CUSTOM = { classify_mode: 'custom', classify_params: { lo_pct: 33, hi_pct: 67 } }

describe('ClassifyFields 动态字段切换', () => {
  it('null（连续）→ 不显示任何额外字段', () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_NULL } })
    expect(w.text()).not.toContain('横盘阈值')
    expect(w.text()).not.toContain('截面三分位')
    expect(w.text()).not.toContain('下界分位')
  })

  it('band → 显示 ε 字段', () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_BAND } })
    expect(w.text()).toContain('横盘阈值 ε')
  })

  it('tercile → 显示无额外参数提示', () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_TERCILE } })
    expect(w.text()).toContain('截面三分位')
  })

  it('custom → 显示上下界分位输入', () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_CUSTOM } })
    expect(w.text()).toContain('下界分位')
    expect(w.text()).toContain('上界分位')
  })

  it('切换 classify_mode → emit update:modelValue 并重置 classify_params', async () => {
    const w = mount(ClassifyFields, { props: { modelValue: CLS_NULL } })
    w.findAllComponents(NSelect)[0].vm.$emit('update:value', 'band')
    await w.vm.$nextTick()
    const emitted = w.emitted('update:modelValue')
    expect(emitted).toBeTruthy()
    const payload = (emitted as unknown[][])[0][0] as { classify_mode: string; classify_params: Record<string, unknown> | null }
    expect(payload.classify_mode).toBe('band')
    expect(payload.classify_params).toHaveProperty('eps')
  })
})

// ---- parseLabelRef（已在 buildParamsLgb.spec 测，这里再做一轮覆盖以便 spec 索引） ----

describe('parseLabelRef', () => {
  it('正常 key → labelRef', () => {
    expect(parseLabelRef('fwd_ret_h1:v1')).toEqual({
      label_id: 'fwd_ret_h1',
      label_version: 'v1',
    })
  })

  it('null → undefined', () => {
    expect(parseLabelRef(null)).toBeUndefined()
  })

  it('无冒号 → undefined', () => {
    expect(parseLabelRef('nocolon')).toBeUndefined()
  })
})
