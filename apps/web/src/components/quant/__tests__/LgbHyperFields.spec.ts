/**
 * LgbHyperFields：9 个 lgb 树参数控件 + disableEarlyStopping。
 *  - 渲染 9 个 n-input-number
 *  - 修改某字段 → emit update:modelValue 合并已有值
 *  - disableEarlyStopping=true → early_stopping_rounds 输入禁用
 */
import { describe, it, expect } from 'vitest'
import { mount } from '@vue/test-utils'
import { NInputNumber } from 'naive-ui'
import LgbHyperFields from '../train-modal/LgbHyperFields.vue'

const EMPTY = {
  num_leaves: null,
  min_data_in_leaf: null,
  feature_fraction: null,
  learning_rate: null,
  num_boost_round: null,
  early_stopping_rounds: null,
  bagging_fraction: null,
  lambda_l1: null,
  lambda_l2: null,
}

describe('LgbHyperFields', () => {
  it('渲染 9 个 n-input-number', () => {
    const w = mount(LgbHyperFields, { props: { modelValue: { ...EMPTY } } })
    expect(w.findAllComponents(NInputNumber)).toHaveLength(9)
  })

  it('修改字段 → emit 合并已有值', async () => {
    const w = mount(LgbHyperFields, {
      props: { modelValue: { ...EMPTY, num_leaves: 31 } },
    })
    w.findAllComponents(NInputNumber)[0].vm.$emit('update:value', 64)
    await w.vm.$nextTick()
    const ev = w.emitted('update:modelValue')
    expect(ev).toBeTruthy()
    expect((ev![0][0] as Record<string, unknown>).num_leaves).toBe(64)
  })

  it('disableEarlyStopping=true → 恰好一个输入被禁用', () => {
    const w = mount(LgbHyperFields, {
      props: { modelValue: { ...EMPTY }, disableEarlyStopping: true },
    })
    const disabled = w
      .findAllComponents(NInputNumber)
      .filter((c) => c.props('disabled') === true)
    expect(disabled).toHaveLength(1)
  })

  it('默认 disableEarlyStopping=false → 无禁用输入', () => {
    const w = mount(LgbHyperFields, { props: { modelValue: { ...EMPTY } } })
    const disabled = w
      .findAllComponents(NInputNumber)
      .filter((c) => c.props('disabled') === true)
    expect(disabled).toHaveLength(0)
  })
})
